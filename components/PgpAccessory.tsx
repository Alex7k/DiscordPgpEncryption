/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { useAwaiter } from "@utils/react";
import { Message } from "@vencord/discord-types";
import { openMediaModal, showToast, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { decryptAttachment, decryptAttachmentGroup, isPgpAttachment, mimeFromFilename } from "../attachments";
import { formatFingerprint, getPgpKeyPayload, parseSharedKey, type SharedKeyInfo } from "../crypto";
import { getContacts, setContact } from "../keyStore";
import { type AttachmentGroup, attachmentGroups, type AttachmentState, attachmentStates, enabledChannels, messageAttachmentGroups, messageStates } from "../state";
import { ensureUnlocked } from "./UnlockModal";

type ImportStatus = "own" | "new" | "imported" | "changed" | "invalid";

interface ShareInfo {
    status: ImportStatus;
    key?: SharedKeyInfo;
}

function KeyShareCard({ message, payload }: { message: Message; payload: string; }) {
    const [nonce, setNonce] = useState(0);

    const [info] = useAwaiter<ShareInfo | null>(async () => {
        let key: SharedKeyInfo;
        try {
            key = await parseSharedKey(payload);
        } catch {
            return { status: "invalid" };
        }

        if (message.author?.id === UserStore.getCurrentUser()?.id)
            return { status: "own", key };

        const existing = (await getContacts())[message.author.id];
        if (!existing) return { status: "new", key };
        return { status: existing.fingerprint === key.fingerprint ? "imported" : "changed", key };
    }, { fallbackValue: null, deps: [message.content, nonce] });

    if (!info) return null;

    if (info.status === "invalid") {
        return <div className="vc-pgp-accessory vc-pgp-failed">🔑 Shared PGP key could not be parsed</div>;
    }

    const { key } = info as Required<ShareInfo>;
    const fingerprint = formatFingerprint(key.fingerprint);
    const authorName = message.author?.username ?? "Unknown user";

    async function importKey() {
        await setContact(message.author.id, {
            publicKey: key.publicKey,
            fingerprint: key.fingerprint,
            importedAt: Date.now()
        });
        showToast(`Imported PGP key for ${authorName}`);
        setNonce(n => n + 1);
    }

    switch (info.status) {
        case "own":
            return (
                <div className="vc-pgp-accessory">
                    🔑 Your public PGP key · <span className="vc-pgp-fingerprint">{fingerprint}</span>
                </div>
            );
        case "imported":
            return (
                <div className="vc-pgp-accessory">
                    🔑 {authorName}'s PGP key · <span className="vc-pgp-fingerprint">{fingerprint}</span> · ✓ imported
                </div>
            );
        case "changed":
            return (
                <div className="vc-pgp-accessory vc-pgp-card">
                    <div className="vc-pgp-failed">
                        ⚠ {authorName} shared a DIFFERENT key than the one you imported before!
                        Only accept it if you have verified the new fingerprint with them out-of-band.
                    </div>
                    <div className="vc-pgp-fingerprint">{fingerprint}</div>
                    <Button size="small" variant="dangerPrimary" onClick={importKey}>
                        Replace trusted key
                    </Button>
                </div>
            );
        case "new":
            return (
                <div className="vc-pgp-accessory vc-pgp-card">
                    <div>🔑 {authorName} shared their PGP public key ({key.userID})</div>
                    <div className="vc-pgp-fingerprint">{fingerprint}</div>
                    <Button size="small" onClick={importKey}>
                        Import key
                    </Button>
                </div>
            );
    }
}

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** [2,3,4,7] -> "2–4, 7" */
function formatIndexRanges(indices: number[]): string {
    const ranges: string[] = [];
    for (let i = 0; i < indices.length; i++) {
        let end = i;
        while (end + 1 < indices.length && indices[end + 1] === indices[end] + 1) end++;
        ranges.push(end > i ? `${indices[i]}–${indices[end]}` : `${indices[i]}`);
        i = end;
    }
    return ranges.join(", ");
}

/** The one card that stands in for an encrypted attachment in every pre-decryption state */
function FileCard({ title = "Encrypted attachment", sub, danger, progress, actionLabel, action }: {
    title?: string;
    sub?: ReactNode;
    danger?: boolean;
    /** 0..1 fills the progress bar; omit for no bar */
    progress?: number;
    actionLabel?: string;
    action?: () => void;
}) {
    return (
        <div className="vc-pgp-file-card">
            <div className="vc-pgp-file-icon">🔒</div>
            <div className="vc-pgp-file-body">
                <div className={danger ? "vc-pgp-file-title vc-pgp-failed" : "vc-pgp-file-title"}>{title}</div>
                {sub && <div className="vc-pgp-file-sub">{sub}</div>}
                {progress !== undefined && (
                    <div className="vc-pgp-progress-track">
                        <div className="vc-pgp-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                    </div>
                )}
            </div>
            {action && actionLabel && (
                <Button size="small" onClick={action}>{actionLabel}</Button>
            )}
        </div>
    );
}

/** The fields DecryptedAttachment needs; both single attachments and reassembled groups have them */
interface DecryptedMedia {
    blobUrl?: string;
    filename?: string;
    size: number;
    verified?: boolean | null;
}

function DecryptedAttachment({ att }: { att: DecryptedMedia; }) {
    // image dimensions are needed to open Discord's native viewer; captured on load
    const [dims, setDims] = useState<{ width: number; height: number; } | null>(null);
    const mime = mimeFromFilename(att.filename ?? "");
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");

    function openViewer() {
        if (!att.blobUrl || !dims) return;
        openMediaModal({
            items: [{
                url: att.blobUrl,
                original: att.blobUrl,
                type: "IMAGE",
                alt: att.filename,
                width: dims.width,
                height: dims.height
            }]
        });
    }

    // Images open Discord's native viewer on click; video/audio use standard
    // HTML5 players (Discord's video modal rewrites blob URLs through the proxy)
    const media = isImage
        ? <img
            src={att.blobUrl}
            alt={att.filename}
            className="vc-pgp-media vc-pgp-clickable"
            onLoad={(e: any) => setDims({ width: e.target.naturalWidth, height: e.target.naturalHeight })}
            onClick={openViewer}
        />
        : isVideo
            ? <video src={att.blobUrl} controls className="vc-pgp-media" />
            : mime.startsWith("audio/")
                ? <audio src={att.blobUrl} controls />
                : null;
    const sig = att.verified === true
        ? " · ✓"
        : att.verified === false ? " · ⚠ SIGNATURE INVALID" : "";

    return (
        <div className="vc-pgp-attachment">
            {media}
            <div className={att.verified === false ? "vc-pgp-accessory vc-pgp-failed" : "vc-pgp-accessory"}>
                🔒 {att.filename} ({formatSize(att.size)}){sig}
                {" · "}<a href={att.blobUrl} download={att.filename} onClick={e => e.stopPropagation()}>save</a>
            </div>
        </div>
    );
}

function AttachmentCard({ message, att }: { message: Message; att: AttachmentState; }) {
    const retry = () => void decryptAttachment(message.channel_id, message.id, att);
    switch (att.status) {
        case "init":
        case "fetching":
            return <FileCard sub="Decrypting..." />;
        case "locked":
            return <FileCard sub={`${formatSize(att.size)} · your key is locked`} actionLabel="Unlock" action={() => void ensureUnlocked()} />;
        case "too-large":
            return <FileCard sub={formatSize(att.size)} actionLabel="Decrypt" action={retry} />;
        case "failed":
            return (
                <FileCard
                    danger
                    title="Decryption failed"
                    sub={<>{att.reason} · <a href={att.url} target="_blank" rel="noreferrer">ciphertext</a></>}
                    actionLabel="Retry"
                    action={retry}
                />
            );
        case "decrypted":
            return <DecryptedAttachment att={att} />;
    }
}

function GroupAttachmentCard({ message, group }: { message: Message; group: AttachmentGroup; }) {
    // the full card renders once, on the message holding the earliest loaded
    // part; other part messages collapse to a small stub
    const lowestLoaded = Math.min(...group.parts.keys());
    if (group.parts.get(lowestLoaded)?.messageId !== message.id) {
        const held = [...group.parts.entries()]
            .filter(([, part]) => part.messageId === message.id)
            .map(([index]) => index)
            .sort((a, b) => a - b);
        if (!held.length) return null;
        return (
            <div
                className="vc-pgp-accessory vc-pgp-continuation"
                title="continuation of the encrypted file above"
            >
                🔒 file {held.length > 1 ? "parts" : "part"} {formatIndexRanges(held)}/{group.total} ⤴
            </div>
        );
    }

    switch (group.status) {
        case "waiting":
            return <FileCard sub={`receiving parts · ${group.parts.size}/${group.total}`} progress={group.parts.size / group.total} />;
        case "locked":
            return <FileCard sub={`${formatSize(group.size)} · your key is locked`} actionLabel="Unlock" action={() => void ensureUnlocked()} />;
        case "too-large":
            return <FileCard sub={formatSize(group.size)} actionLabel="Decrypt" action={() => void decryptAttachmentGroup(group)} />;
        case "fetching":
            return <FileCard sub="Decrypting..." progress={(group.progress ?? 0) / group.total} />;
        case "failed": {
            const parts = [...group.parts.entries()].sort(([a], [b]) => a - b);
            return (
                <FileCard
                    danger
                    title="Decryption failed"
                    sub={<>
                        {group.reason} · ciphertext:
                        {parts.map(([index, part]) => (
                            <a key={index} className="vc-pgp-part-link" href={part.url} target="_blank" rel="noreferrer">{index}</a>
                        ))}
                    </>}
                    actionLabel="Retry"
                    action={() => void decryptAttachmentGroup(group)}
                />
            );
        }
        case "decrypted":
            return <DecryptedAttachment att={group} />;
    }
}

function AttachmentCards({ message }: { message: Message; }) {
    const list = attachmentStates.get(message.id) ?? [];
    const groupIds = messageAttachmentGroups.get(message.id);
    const groups = groupIds
        ? [...groupIds].map(id => attachmentGroups.get(id)).filter((g): g is AttachmentGroup => !!g)
        : [];
    if (!list.length && !groups.length) return null;

    return (
        <>
            {list.map(att => <AttachmentCard key={att.id} message={message} att={att} />)}
            {groups.map(group => <GroupAttachmentCard key={group.id} message={message} group={group} />)}
        </>
    );
}

/** "the attachment is", "stickers are", ... or null when the message has no plain media */
function plainMediaWarning(message: Message): string | null {
    // encrypted attachments are handled by their own cards, not this warning
    const attachments = message.attachments?.filter(a => !isPgpAttachment(a)).length ?? 0;
    const stickers = message.stickerItems?.length ?? 0;
    if (attachments && stickers) return "attachments and stickers are";
    if (attachments) return attachments === 1 ? "the attachment is" : "attachments are";
    if (stickers) return stickers === 1 ? "the sticker is" : "stickers are";
    return null;
}

function StatusLine({ message }: { message: Message; }) {
    const state = messageStates.get(message.id);
    if (!state) {
        // attachment-only or sticker-only messages never pass through encryption,
        // so in an encrypted channel they deserve the warning on their own
        if (!enabledChannels.has(message.channel_id)) return null;
        const plain = plainMediaWarning(message);
        return plain
            ? <div className="vc-pgp-accessory vc-pgp-warn">⚠ {plain} NOT encrypted</div>
            : null;
    }

    switch (state.type) {
        case "pending":
            return (
                <div
                    className="vc-pgp-accessory vc-pgp-clickable"
                    onClick={() => void ensureUnlocked()}
                >
                    🔒 Encrypted message. Click to unlock your PGP key
                </div>
            );
        case "failed":
            return <div className="vc-pgp-accessory vc-pgp-failed">🔒 Could not decrypt: {state.reason}</div>;
        case "continuation":
            return (
                <div
                    className="vc-pgp-accessory vc-pgp-continuation"
                    title={`part ${state.index}/${state.total} of the encrypted message above`}
                >
                    🔒 message part {state.index}/{state.total} ⤴
                </div>
            );
        case "decrypted": {
            // the everyday all-good line stays tiny; details live in the
            // tooltip. Only problems get spelled out loudly.
            const part = state.part && !state.part.merged
                ? ` · part ${state.part.index}/${state.part.total}`
                : "";
            const tooltip = "End-to-end encrypted"
                + (state.verified === true ? " · signature verified" : "")
                + (state.part?.merged ? ` · combined from ${state.part.total} messages` : "");
            const sig = state.verified === false
                ? " ⚠ SIGNATURE INVALID — not signed by the sender's trusted key"
                : state.verified === null
                    ? " · sender key unknown, signature not checked"
                    : " ✓";
            // only the text is encrypted; anything else riding on the message is not
            const plain = plainMediaWarning(message);
            return (
                <div
                    className={state.verified === false ? "vc-pgp-accessory vc-pgp-failed" : "vc-pgp-accessory"}
                    title={tooltip}
                >
                    🔒{sig}{part}
                    {plain && <span className="vc-pgp-warn"> · ⚠ {plain} NOT encrypted</span>}
                </div>
            );
        }
    }
}

export function PgpAccessory({ message }: { message?: Message; }) {
    if (!message?.id) return null;

    const keyPayload = getPgpKeyPayload(message.content ?? "");

    return (
        <>
            {keyPayload !== null
                ? <KeyShareCard message={message} payload={keyPayload} />
                : <StatusLine message={message} />}
            <AttachmentCards message={message} />
        </>
    );
}
