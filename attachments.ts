/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { updateMessage } from "@api/MessageUpdater";
import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { CloudUpload, Message, MessageAttachment } from "@vencord/discord-types";
import { findLazy } from "@webpack";
import { ChannelStore, MessageStore, RestAPI, UserStore } from "@webpack/common";
import type { PrivateKey } from "openpgp";

import { ensureUnlocked } from "./components/UnlockModal";
import { decryptFileBytes, encryptFileBytes, makeFilePartMeta, makeGroupId, MAX_ATTACHMENT_PARTS, parseFilePartMeta } from "./crypto";
import { getContacts, getOwnKey, getSessionKey } from "./keyStore";
import { openPgpSettings } from "./openSettings";
import { settings } from "./settings";
import { type AttachmentGroup, attachmentGroups, type AttachmentState, attachmentStates, enabledChannels, messageAttachmentGroups, pendingMessages } from "./state";

const logger = new Logger("PgpEncrypt", "#7289da");

// The CDN only sends CORS headers for files it classifies as images by
// extension, and its media proxy re-encodes anything else, so a plain ".pgp"
// upload can never be fetched back for decryption. We give the ciphertext a
// ".webp" extension: it counts as an image (cdn adds CORS) but Discord's
// converter only turns OTHER formats INTO webp, so it leaves an already-webp
// file's bytes untouched. We always fetch from the original cdn url, never the
// re-encoding media proxy.
export const ENCRYPTED_FILENAME = "encrypted.pgp.webp";
/** Bigger files are click-to-decrypt so scrolling old media doesn't eat memory */
const AUTO_DECRYPT_MAX_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
    pdf: "application/pdf", txt: "text/plain"
};

export function mimeFromFilename(filename: string): string {
    const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// matches the current ".pgp.png" as well as older ".pgp" uploads
export const isPgpAttachment = (attachment: { filename?: string; }) => /\.pgp(\.\w+)?$/i.test(attachment.filename ?? "");

/** How many attachments Discord allows on one message */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const encryptedPartFilename = (groupId: string, index: number, total: number) =>
    `encrypted-${groupId}-${index}of${total}.pgp.webp`;

const PART_FILENAME_RE = /^encrypted-([0-9a-f]{8})-(\d+)of(\d+)\.pgp\.webp$/i;

interface PartFilenameInfo {
    groupId: string;
    index: number;
    total: number;
}

/**
 * Parses the unauthenticated grouping hint out of a part upload's filename.
 * Only used to group parts for the UI; the signed metadata inside the
 * ciphertext decides the actual reassembly.
 */
export function parsePartFilename(filename?: string): PartFilenameInfo | null {
    const match = PART_FILENAME_RE.exec(filename ?? "");
    if (!match) return null;

    const index = Number(match[2]);
    const total = Number(match[3]);
    if (index < 1 || total < 2 || index > total || total > MAX_ATTACHMENT_PARTS) return null;

    return { groupId: match[1].toLowerCase(), index, total };
}

function notify(body: string, onClick?: () => void) {
    showNotification({ title: "PGP Encryption", body, onClick });
}

// #region Encrypt (outgoing uploads)

const CloudUploadClass = findLazy((m: any) => m.prototype?.trackUploadFinished);
const ENCRYPTED_MARK = Symbol("pgpEncrypted");
let originalUpload: ((...args: any[]) => any) | undefined;

/**
 * Discord starts uploading a file the moment it is attached, before send, so
 * hooking the send path is too late (the plaintext is already on the cdn). We
 * wrap the per-file upload() so the bytes are encrypted right before they leave.
 */
export function installUploadInterception() {
    if (originalUpload) return;
    const proto = CloudUploadClass.prototype;
    originalUpload = proto.upload;

    proto.upload = async function (this: CloudUpload, ...args: any[]) {
        try {
            await encryptUpload(this);
        } catch (e) {
            // never fall through to uploading plaintext
            logger.warn("Aborting upload", e);
            throw e;
        }
        return originalUpload!.apply(this, args);
    };
}

export function uninstallUploadInterception() {
    if (originalUpload) {
        CloudUploadClass.prototype.upload = originalUpload;
        originalUpload = undefined;
    }
}

/** Discord's per-file upload cap for the current user. Only DMs here, so boosts don't apply. */
function getUploadSizeLimit(): number {
    switch (UserStore.getCurrentUser()?.premiumType) {
        case 2: return 500 * 1024 * 1024; // nitro
        case 1: case 3: return 50 * 1024 * 1024; // classic / basic
        default: return 10 * 1024 * 1024;
    }
}

/** Room the OpenPGP packets add around a chunk (session keys per recipient, signature, headers) */
const ENCRYPTION_MARGIN = 64 * 1024;

// Discord also caps the SUM of a message's attachments at 500 MB (enforced
// server-side, not just the client gate we patch). We keep each message's parts
// safely under that, so a split file's messages are never rejected on send.
const MAX_MESSAGE_TOTAL_BYTES = 490 * 1024 * 1024;

/**
 * Greedily packs part files into messages, each holding at most 10 attachments
 * and staying under the total-message-size cap. Every part is at most one chunk,
 * which is itself under the cap, so each part always fits in some message.
 */
function packPartsIntoMessages(files: File[]): File[][] {
    const messages: File[][] = [];
    let current: File[] = [];
    let currentBytes = 0;

    for (const file of files) {
        if (current.length > 0 && (current.length >= MAX_ATTACHMENTS_PER_MESSAGE || currentBytes + file.size > MAX_MESSAGE_TOTAL_BYTES)) {
            messages.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(file);
        currentBytes += file.size;
    }
    if (current.length > 0) messages.push(current);
    return messages;
}

/** Swaps the upload's file for its encrypted replacement and sets the flags every encrypted upload needs */
function applyEncryptedFile(upload: CloudUpload & { [ENCRYPTED_MARK]?: boolean; }, file: File) {
    // .webp extension + type so the cdn serves it with CORS headers while
    // Discord's converter leaves it alone (it only converts INTO webp)
    upload.item.file = file;
    upload.filename = file.name;
    upload.mimeType = "image/webp";
    upload.isImage = false;
    upload.isVideo = false;
    upload.maybeConvertToWebP = async () => { };
    // The size fields were captured from the ORIGINAL file when the CloudUpload
    // was constructed. getSize() (and the server-side upload reservation) reads
    // currentSize, so an oversized original whose bytes we replaced with a small
    // part would still reserve the original size and be rejected server-side
    // (40005 POSTCOMPRESSION_SUM_TOO_LARGE). Point every size field at the part.
    upload.currentSize = file.size;
    upload.preCompressionSize = file.size;
    upload.postCompressionSize = file.size;
    // alt text would sit in the message payload in plaintext
    upload.description = null;
    upload[ENCRYPTED_MARK] = true;
}

/** Encrypts one upload's bytes in place. No-op outside enabled channels; throws to abort. */
async function encryptUpload(upload: CloudUpload & { [ENCRYPTED_MARK]?: boolean; }) {
    if (upload[ENCRYPTED_MARK]) return;
    if (!settings.store.encryptAttachments || !enabledChannels.has(upload.channelId)) return;

    const file = upload.item?.file;
    if (!file) return;

    // an already-encrypted part generated by the split path below re-enters
    // this hook when it is attached; it only needs the upload flags
    if (parsePartFilename(file.name)) {
        applyEncryptedFile(upload, file);
        return;
    }

    const channel = ChannelStore.getChannel(upload.channelId);
    if (!channel?.isPrivate()) return;

    const ownKey = await getOwnKey();
    if (!ownKey) {
        notify("Attachment not sent: you have no PGP keypair. Click here to open the plugin settings.", openPgpSettings);
        throw new Error("PgpEncrypt: no keypair, upload aborted");
    }

    const contacts = await getContacts();
    const missing = channel.recipients.filter(id => !contacts[id]);
    if (missing.length > 0) {
        const names = missing.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
        notify(`Attachment not sent: missing PGP keys for ${names}.`);
        throw new Error("PgpEncrypt: missing recipient keys, upload aborted");
    }

    const signingKey = await ensureUnlocked();
    if (!signingKey) throw new Error("PgpEncrypt: key locked, upload aborted");

    const recipientKeys = [...channel.recipients.map(id => contacts[id].publicKey), ownKey.publicKey];
    // stay under both the per-file limit and the per-message total, so every
    // encrypted part fits a message on its own (matters for Nitro, where the
    // per-file limit alone equals the total-message cap)
    const chunkSize = Math.min(getUploadSizeLimit(), MAX_MESSAGE_TOTAL_BYTES) - ENCRYPTION_MARGIN;

    if (file.size <= chunkSize) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encryptedBytes = await encryptFileBytes(bytes, file.name, recipientKeys, signingKey);
        applyEncryptedFile(upload, new File([encryptedBytes as unknown as BlobPart], ENCRYPTED_FILENAME, { type: "image/webp" }));
        logger.info(`encrypted upload: ${file.name} ${bytes.length}B -> ${ENCRYPTED_FILENAME} ${encryptedBytes.length}B`);
        return;
    }

    if (!settings.store.splitAttachments) {
        // the file size gate is only lifted while splitting is on, so we should
        // not reach here with it off; abort defensively rather than upload a
        // ciphertext that is itself over the limit and cannot be sent
        notify(`Attachment not sent: ${file.name} is over your upload size limit and attachment splitting is disabled.`);
        throw new Error("PgpEncrypt: attachment over size limit, splitting disabled, upload aborted");
    }

    await splitUploadIntoParts(upload, file, recipientKeys, signingKey, chunkSize);
}

// #endregion

// #region Split oversized uploads

/** Follow-up messages of encrypted parts that did not fit next to part 1, by group id. Sent once the draft goes out. */
const pendingUploadParts = new Map<string, { channelId: string; messages: File[][]; }>();

/**
 * Splits a file that is over the upload size limit into independently
 * encrypted part uploads. Only part 1 (a single within-limit file) rides in the
 * composer with the user's message; every other part is queued and sent as our
 * own follow-up messages once this message goes out.
 *
 * Extra parts deliberately do NOT go into the composer draft: Discord re-runs
 * its size/count gates on the whole draft at send, and a draft holding several
 * ~limit-sized parts trips the aggregate-size and 10-attachment limits (which
 * are enforced server-side too). Sending the rest ourselves via RestAPI skips
 * that path entirely, so only the lone part 1 is ever gate-checked.
 */
async function splitUploadIntoParts(
    upload: CloudUpload & { [ENCRYPTED_MARK]?: boolean; },
    file: File,
    recipientKeys: string[],
    signingKey: PrivateKey,
    chunkSize: number
) {
    const total = Math.ceil(file.size / chunkSize);
    if (total > MAX_ATTACHMENT_PARTS) {
        notify(`Attachment not sent: ${file.name} would need ${total} encrypted parts, more than the ${MAX_ATTACHMENT_PARTS} supported.`);
        throw new Error("PgpEncrypt: attachment too large to split, upload aborted");
    }

    const groupId = makeGroupId();
    const parts: File[] = [];
    // sequential so only one chunk of plaintext + ciphertext is held at a time
    for (let index = 1; index <= total; index++) {
        const chunk = new Uint8Array(await file.slice((index - 1) * chunkSize, index * chunkSize).arrayBuffer());
        const encrypted = await encryptFileBytes(chunk, makeFilePartMeta(groupId, index, total, file.name), recipientKeys, signingKey);
        parts.push(new File([encrypted as unknown as BlobPart], encryptedPartFilename(groupId, index, total), { type: "image/webp" }));
    }

    applyEncryptedFile(upload, parts[0]);

    const followUps = packPartsIntoMessages(parts.slice(1));
    if (followUps.length) pendingUploadParts.set(groupId, { channelId: upload.channelId, messages: followUps });

    logger.info(`split upload: ${file.name} ${file.size}B -> ${total} parts (group ${groupId}, ${followUps.length} follow-up messages)`);
    notify(
        `${file.name} is over your upload size limit; encrypted as ${total} parts`
        + (followUps.length ? `, sent across ${followUps.length + 1} messages when you send.` : ".")
    );
}

/**
 * Sends the queued overflow parts of a group once the message carrying its
 * part 1 shows up. Nothing is ever sent if the draft gets discarded instead.
 */
export function maybeSendPendingParts(channelId: string, message: Message) {
    if (pendingUploadParts.size === 0) return;
    if (message.author?.id !== UserStore.getCurrentUser()?.id) return;

    for (const attachment of message.attachments ?? []) {
        const info = parsePartFilename(attachment.filename);
        if (info?.index !== 1) continue;

        const pending = pendingUploadParts.get(info.groupId);
        if (!pending || pending.channelId !== channelId) continue;

        pendingUploadParts.delete(info.groupId);
        void sendOverflowParts(channelId, pending.messages);
    }
}

async function sendOverflowParts(channelId: string, messages: File[][]) {
    try {
        for (let i = 0; i < messages.length; i++) {
            // a big file can be many follow-up messages; space them out so
            // Discord's per-channel message rate limit and spam heuristics don't
            // reject a message and leave the file un-reassemblable
            if (i > 0) await new Promise(resolve => setTimeout(resolve, 1200));
            await sendFilesMessage(channelId, messages[i]);
        }
    } catch (e) {
        logger.error("Failed to send follow-up attachment parts", e);
        notify("Failed to send the remaining encrypted attachment parts; the file cannot be decrypted without them. Re-send the attachment.");
    }
}

/** Uploads already-encrypted part files and posts them as one attachment-only message */
async function sendFilesMessage(channelId: string, files: File[]) {
    const uploads: CloudUpload[] = files.map(file =>
        new CloudUploadClass({ file, platform: 1 }, channelId)
    );

    for (const upload of uploads) {
        // runs through the wrapped upload(), which only applies the flags here
        await upload.upload();
        if (!upload.uploadedFilename) {
            await new Promise<void>((resolve, reject) => {
                upload.once("complete", () => resolve());
                upload.once("error", (e: any) => reject(e instanceof Error ? e : new Error("upload failed")));
            });
        }
    }

    await RestAPI.post({
        url: `/channels/${channelId}/messages`,
        body: {
            content: "",
            channel_id: channelId,
            type: 0,
            sticker_ids: [],
            attachments: uploads.map((upload, i) => ({
                id: String(i),
                filename: upload.filename,
                uploaded_filename: upload.uploadedFilename
            }))
        }
    });
}

// #endregion

// #region Decrypt (incoming attachments)

export function handleEncryptedAttachments(channelId: string, message: Message) {
    for (const attachment of message.attachments ?? []) {
        if (!isPgpAttachment(attachment)) continue;

        const part = parsePartFilename(attachment.filename);
        if (part) {
            // a mismatched or duplicate part is not registered; its raw file
            // card stays visible instead of silently disappearing
            if (!registerGroupPart(channelId, message, attachment, part)) continue;
        } else {
            let list = attachmentStates.get(message.id);
            if (!list) attachmentStates.set(message.id, list = []);
            if (!list.some(s => s.id === attachment.id)) {
                list.push({
                    id: attachment.id,
                    url: attachment.url,
                    size: attachment.size ?? 0,
                    authorId: message.author?.id,
                    status: "init"
                });
            }
        }

        // The raw ciphertext file card is useless to the reader; from here on
        // the accessory card represents the attachment in every state (and
        // links the ciphertext on failure). Deferred so it never runs inside
        // the dispatch that delivered the message.
        const attachmentId = attachment.id;
        queueMicrotask(() => stripAttachment(channelId, message.id, attachmentId));
    }

    // Process from the registered state, not the attachments seen this pass:
    // the retry after unlocking passes the STORED message, whose raw encrypted
    // attachments were already stripped on an earlier pass.
    if (attachmentStates.has(message.id)) void processAttachments(channelId, message.id);
    for (const groupId of messageAttachmentGroups.get(message.id) ?? []) {
        const group = attachmentGroups.get(groupId);
        if (group) void processGroup(group);
    }
}

async function processAttachments(channelId: string, messageId: string) {
    const list = attachmentStates.get(messageId);
    if (!list) return;

    let changed = false;
    for (const att of list) {
        if (att.status !== "init" && att.status !== "locked") continue;
        changed = true;

        if (!await getOwnKey()) {
            att.status = "failed";
            att.reason = "You have no PGP keypair";
            // retried when a keypair is generated or imported
            pendingMessages.set(messageId, channelId);
            continue;
        }
        if (!getSessionKey()) {
            att.status = "locked";
            pendingMessages.set(messageId, channelId);
            continue;
        }
        if (att.size > AUTO_DECRYPT_MAX_BYTES) {
            att.status = "too-large";
            continue;
        }
        void decryptAttachment(channelId, messageId, att);
    }
    if (changed) updateMessage(channelId, messageId);
}

/**
 * Fetches the pristine ciphertext from the cdn url. Never the proxy_url: the
 * media proxy re-encodes attachments and would corrupt the bytes.
 */
async function fetchCiphertext(att: { url: string; }): Promise<Uint8Array> {
    const response = await fetch(att.url);
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
}

/** Fetches the ciphertext from the CDN, decrypts it, and swaps in a blob URL */
export async function decryptAttachment(channelId: string, messageId: string, att: AttachmentState) {
    att.status = "fetching";
    updateMessage(channelId, messageId);

    try {
        const privateKey = getSessionKey();
        if (!privateKey) throw new Error("your PGP key is locked");

        const bytes = await fetchCiphertext(att);

        let verificationKey: string | undefined;
        if (att.authorId === UserStore.getCurrentUser()?.id) {
            verificationKey = (await getOwnKey())?.publicKey;
        } else if (att.authorId) {
            verificationKey = (await getContacts())[att.authorId]?.publicKey;
        }

        const { data, filename, verified } = await decryptFileBytes(bytes, privateKey, verificationKey);

        if (att.blobUrl) URL.revokeObjectURL(att.blobUrl);
        att.blobUrl = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mimeFromFilename(filename) }));
        att.filename = filename;
        att.size = data.length;
        att.verified = verified;
        att.status = "decrypted";
    } catch (e) {
        logger.info(`Failed to decrypt attachment ${att.id}`, e);
        att.status = "failed";
        att.reason = e instanceof Error ? e.message : String(e);
    }
    updateMessage(channelId, messageId);
}

/** Removes a raw encrypted-file card from the message; the accessory card represents it instead */
function stripAttachment(channelId: string, messageId: string, attachmentId: string) {
    const stored = MessageStore.getMessage(channelId, messageId);
    if (!stored?.attachments) return;

    updateMessage(channelId, messageId, {
        attachments: stored.attachments.filter((a: MessageAttachment) => a.id !== attachmentId)
    });
}

// #endregion

// #region Reassemble split attachments

function registerGroupPart(
    channelId: string,
    message: Message,
    attachment: MessageAttachment,
    info: { groupId: string; index: number; total: number; }
): AttachmentGroup | null {
    let group = attachmentGroups.get(info.groupId);
    if (!group) {
        group = {
            id: info.groupId,
            total: info.total,
            authorId: message.author?.id,
            parts: new Map(),
            status: "waiting",
            size: 0
        };
        attachmentGroups.set(info.groupId, group);
    }

    // all parts must come from whoever sent the first one we saw, so another
    // group member can't inject parts under a group id they observed
    if (group.total !== info.total || message.author?.id !== group.authorId) {
        logger.warn(`ignoring part ${info.index} of attachment group ${info.groupId}: metadata mismatch`);
        return null;
    }

    const existing = group.parts.get(info.index);
    if (existing) {
        // the same attachment re-announced (MESSAGE_UPDATE) is fine; a
        // different upload claiming an occupied slot is not registered
        return existing.messageId === message.id && existing.attachmentId === attachment.id
            ? group
            : null;
    }

    group.parts.set(info.index, {
        messageId: message.id,
        channelId,
        attachmentId: attachment.id,
        url: attachment.url,
        size: attachment.size ?? 0
    });
    if (group.status !== "decrypted") {
        group.size = [...group.parts.values()].reduce((sum, p) => sum + p.size, 0);
    }

    let groupIds = messageAttachmentGroups.get(message.id);
    if (!groupIds) messageAttachmentGroups.set(message.id, groupIds = new Set());
    groupIds.add(group.id);

    return group;
}

async function processGroup(group: AttachmentGroup) {
    if (group.status === "fetching" || group.status === "decrypted") return;

    if (group.parts.size < group.total) {
        group.status = "waiting";
        updateGroupMessages(group);
        return;
    }

    if (!await getOwnKey()) {
        group.status = "failed";
        group.reason = "You have no PGP keypair";
        markGroupPending(group);
        updateGroupMessages(group);
        return;
    }
    if (!getSessionKey()) {
        group.status = "locked";
        markGroupPending(group);
        updateGroupMessages(group);
        return;
    }
    if (group.size > AUTO_DECRYPT_MAX_BYTES) {
        group.status = "too-large";
        updateGroupMessages(group);
        return;
    }

    void decryptAttachmentGroup(group);
}

/** Queues every part's message for a retry once the key becomes available */
function markGroupPending(group: AttachmentGroup) {
    for (const part of group.parts.values()) {
        pendingMessages.set(part.messageId, part.channelId);
    }
}

/**
 * Fetches and decrypts every part of a complete group and reassembles them
 * into one file. Part order comes from the signed metadata inside each
 * ciphertext, never from the (spoofable) upload filenames.
 */
export async function decryptAttachmentGroup(group: AttachmentGroup) {
    if (group.status === "fetching" || group.status === "decrypted") return;
    if (group.parts.size < group.total) return;

    group.status = "fetching";
    group.progress = 0;
    updateGroupMessages(group);

    try {
        const privateKey = getSessionKey();
        if (!privateKey) throw new Error("your PGP key is locked");

        let verificationKey: string | undefined;
        if (group.authorId === UserStore.getCurrentUser()?.id) {
            verificationKey = (await getOwnKey())?.publicKey;
        } else if (group.authorId) {
            verificationKey = (await getContacts())[group.authorId]?.publicKey;
        }

        const chunks: (Uint8Array | undefined)[] = new Array(group.total);
        const signatures: (boolean | null)[] = [];
        let filename = "file";

        for (let index = 1; index <= group.total; index++) {
            group.progress = index;
            updateGroupMessages(group);

            const bytes = await fetchCiphertext(group.parts.get(index)!);
            const { data, filename: metaName, verified } = await decryptFileBytes(bytes, privateKey, verificationKey);

            const meta = parseFilePartMeta(metaName);
            if (!meta || meta.groupId !== group.id || meta.total !== group.total || chunks[meta.index - 1]) {
                throw new Error(`part ${index} does not belong to this attachment`);
            }
            chunks[meta.index - 1] = data;
            signatures.push(verified);
            filename = meta.filename;
        }

        if (chunks.some(chunk => !chunk)) throw new Error("some parts are missing");

        if (group.blobUrl) URL.revokeObjectURL(group.blobUrl);
        group.blobUrl = URL.createObjectURL(new Blob(chunks as unknown as BlobPart[], { type: mimeFromFilename(filename) }));
        group.filename = filename;
        group.size = chunks.reduce((sum, chunk) => sum + chunk!.length, 0);
        // one bad signature taints the whole file; an uncheckable one taints it down to "unknown"
        group.verified = signatures.some(v => v === false) ? false
            : signatures.every(v => v === true) ? true : null;
        group.status = "decrypted";
    } catch (e) {
        logger.info(`Failed to decrypt attachment group ${group.id}`, e);
        group.status = "failed";
        group.reason = e instanceof Error ? e.message : String(e);
    }
    group.progress = undefined;
    updateGroupMessages(group);
}

/** Re-renders every message that holds a part of the group */
function updateGroupMessages(group: AttachmentGroup) {
    const seen = new Set<string>();
    for (const part of group.parts.values()) {
        if (seen.has(part.messageId)) continue;
        seen.add(part.messageId);
        updateMessage(part.channelId, part.messageId);
    }
}

// #endregion
