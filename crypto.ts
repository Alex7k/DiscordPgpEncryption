/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createMessage, decrypt, decryptKey, encrypt, encryptKey, generateKey, type PrivateKey, readKey, readMessage, readPrivateKey } from "openpgp";

/**
 * Wire format: binary OpenPGP packets as base64 with a short marker prefix,
 * instead of full ASCII armor. Saves ~250 chars of Discord's message limit.
 */
export const PGP_MESSAGE_PREFIX = "pgp:";
export const PGP_KEY_PREFIX = "pgp-key:";

const PGP_MESSAGE_RE = /^pgp:([A-Za-z0-9+/]+={0,2})$/;
const PGP_KEY_RE = /^pgp-key:([A-Za-z0-9+/]+={0,2})$/;

/** Returns the base64 payload if content is a pgp encrypted message, else null */
export const getPgpMessagePayload = (content: string) => PGP_MESSAGE_RE.exec(content.trim())?.[1] ?? null;
/** Returns the base64 payload if content is a shared public key, else null */
export const getPgpKeyPayload = (content: string) => PGP_KEY_RE.exec(content.trim())?.[1] ?? null;

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    // avoid call stack overflow from String.fromCharCode(...hugeArray)
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export interface GeneratedKeyPair {
    /** Armored public key */
    publicKey: string;
    /** Armored private key, locked with the passphrase */
    privateKey: string;
    fingerprint: string;
}

export async function generateKeyPair(userName: string, passphrase: string): Promise<GeneratedKeyPair> {
    const { publicKey, privateKey } = await generateKey({
        userIDs: [{ name: userName }],
        passphrase,
        format: "armored"
    });

    const key = await readKey({ armoredKey: publicKey });

    return {
        publicKey,
        privateKey,
        fingerprint: key.getFingerprint()
    };
}

/** Throws if the passphrase is wrong or the armored key is invalid */
export async function unlockPrivateKey(armoredKey: string, passphrase: string): Promise<PrivateKey> {
    const privateKey = await readPrivateKey({ armoredKey });
    return decryptKey({ privateKey, passphrase });
}

export interface PreparedImport extends GeneratedKeyPair {
    userName: string;
}

/**
 * Validates a pasted armored private key for import. If the key is
 * passphrase-protected, the passphrase must match; if it is unprotected,
 * it gets locked with the given passphrase so we never store it bare.
 * Throws with a readable message on any problem.
 */
export async function prepareKeyImport(armoredKey: string, passphrase: string): Promise<PreparedImport> {
    const privateKey = await readPrivateKey({ armoredKey: armoredKey.trim() });

    let lockedKey: string;
    if (privateKey.isDecrypted()) {
        lockedKey = (await encryptKey({ privateKey, passphrase })).armor();
    } else {
        // validates the passphrase; throws if wrong
        await decryptKey({ privateKey, passphrase });
        lockedKey = privateKey.armor();
    }

    return {
        publicKey: privateKey.toPublic().armor(),
        privateKey: lockedKey,
        fingerprint: privateKey.getFingerprint(),
        userName: privateKey.getUserIDs()[0] || "imported key"
    };
}

/** 40 hex chars -> "ABCD 1234 ..." groups for human comparison */
export function formatFingerprint(fingerprint: string): string {
    return fingerprint.toUpperCase().match(/.{1,4}/g)?.join(" ") ?? fingerprint.toUpperCase();
}

/** Converts an armored public key into the compact "pgp-key:..." share message */
export async function packPublicKeyShare(armoredKey: string): Promise<string> {
    const key = await readKey({ armoredKey });
    return PGP_KEY_PREFIX + toBase64(key.write());
}

export interface SharedKeyInfo {
    /** Armored public key */
    publicKey: string;
    fingerprint: string;
    userID: string;
}

/** Parses the base64 payload of a "pgp-key:..." share message. Throws on garbage. */
export async function parseSharedKey(b64: string): Promise<SharedKeyInfo> {
    const key = await readKey({ binaryKey: fromBase64(b64) });
    if (key.isPrivate()) throw new Error("This is a private key! Never share private keys.");

    return {
        publicKey: key.armor(),
        fingerprint: key.getFingerprint(),
        userID: key.getUserIDs()[0] ?? "unknown"
    };
}

/** Encrypts and signs text for all recipient keys, returning the compact "pgp:..." message */
export async function encryptMessage(text: string, recipientArmoredKeys: string[], signingKey: PrivateKey): Promise<string> {
    const encryptionKeys = await Promise.all(recipientArmoredKeys.map(armoredKey => readKey({ armoredKey })));

    const data = await encrypt({
        message: await createMessage({ text }),
        encryptionKeys,
        signingKeys: signingKey,
        format: "binary"
    });

    return PGP_MESSAGE_PREFIX + toBase64(data as Uint8Array);
}

export const MAX_SPLIT_PARTS = 8;

/**
 * Parts of a split message carry a header line INSIDE the encrypted text, so
 * Discord and non-recipients never learn that messages belong together. The
 * receiving plugin strips it and reassembles the full text client-side.
 */
const PART_HEADER_RE = /^pgp-part:([0-9a-f]{8}):(\d+):(\d+)\n/;

export interface PartHeader {
    groupId: string;
    index: number;
    total: number;
    /** The part's text with the header stripped */
    text: string;
}

/** Returns the part header of a decrypted split message, or null for whole messages */
export function parsePartHeader(decryptedText: string): PartHeader | null {
    const match = PART_HEADER_RE.exec(decryptedText);
    if (!match) return null;

    const index = Number(match[2]);
    const total = Number(match[3]);
    if (index < 1 || total < 2 || index > total || total > 64) return null;

    return { groupId: match[1], index, total, text: decryptedText.slice(match[0].length) };
}

export function makeGroupId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Splits text on code point boundaries into parts of at most targetSize,
 * preferring to cut at whitespace when one is close enough to the boundary
 */
function splitPlaintext(text: string, targetSize: number): string[] {
    const codePoints = Array.from(text);
    const parts: string[] = [];
    let start = 0;

    while (start < codePoints.length) {
        let end = Math.min(start + targetSize, codePoints.length);
        if (end < codePoints.length) {
            const earliestCut = start + Math.ceil(targetSize * 0.8);
            for (let i = end; i > earliestCut; i--) {
                if (/\s/.test(codePoints[i - 1])) {
                    end = i;
                    break;
                }
            }
        }
        parts.push(codePoints.slice(start, end).join(""));
        start = end;
    }

    return parts;
}

/**
 * Encrypts text as several independent "pgp:..." messages that each fit in
 * maxLength. Each part decrypts on its own, so a client that misses one still
 * reads the rest; the hidden part headers let receiving plugins reassemble
 * them into one message. Returns null if even MAX_SPLIT_PARTS are not enough.
 */
export async function encryptMessageChunks(
    text: string,
    recipientArmoredKeys: string[],
    signingKey: PrivateKey,
    maxLength: number,
    startParts = 2
): Promise<string[] | null> {
    const codePointCount = Array.from(text).length;
    const groupId = makeGroupId();

    for (let parts = Math.max(2, startParts); parts <= MAX_SPLIT_PARTS; parts++) {
        const pieces = splitPlaintext(text, Math.ceil(codePointCount / parts));
        if (pieces.length > MAX_SPLIT_PARTS) return null;

        const chunks: string[] = [];
        let fits = true;
        for (let i = 0; i < pieces.length; i++) {
            const withHeader = `pgp-part:${groupId}:${i + 1}:${pieces.length}\n${pieces[i]}`;
            const chunk = await encryptMessage(withHeader, recipientArmoredKeys, signingKey);
            if (chunk.length > maxLength) {
                fits = false;
                break;
            }
            chunks.push(chunk);
        }
        if (fits) return chunks;
    }

    return null;
}

export interface DecryptedMessage {
    text: string;
    /** true/false if the sender's key was available to check the signature, null if not */
    verified: boolean | null;
}

// A file is split into at most this many parts, sent 10 per message across as
// many follow-up messages as needed. At a 50 MB per-file limit that is ~25 GB;
// at Nitro's 500 MB, ~256 GB. The ceiling only guards against absurd part
// counts (each part is a separate upload + a fraction of a Discord message).
export const MAX_ATTACHMENT_PARTS = 512;

/**
 * Metadata for one part of a split attachment, carried in the encrypted
 * literal's filename field so it is signed and hidden from Discord. The outer
 * upload filenames hint the same grouping for the UI before decryption, but
 * only this copy is trusted when reassembling: renaming the uploads cannot
 * reorder or swap parts.
 */
export function makeFilePartMeta(groupId: string, index: number, total: number, filename: string): string {
    return `pgp-part:${groupId}:${index}:${total}:${filename}`;
}

const FILE_PART_META_RE = /^pgp-part:([0-9a-f]{8}):(\d+):(\d+):([\s\S]*)$/;

export interface FilePartMeta {
    groupId: string;
    index: number;
    total: number;
    /** The original filename of the whole file */
    filename: string;
}

/** Returns the part metadata of a decrypted attachment part, or null for whole files */
export function parseFilePartMeta(name: string): FilePartMeta | null {
    const match = FILE_PART_META_RE.exec(name);
    if (!match) return null;

    const index = Number(match[2]);
    const total = Number(match[3]);
    if (index < 1 || total < 2 || index > total || total > MAX_ATTACHMENT_PARTS) return null;

    return { groupId: match[1], index, total, filename: match[4] || "file" };
}

/**
 * Encrypts file bytes for all recipients, signed. The original filename is
 * stored INSIDE the encrypted literal packet, so the upload can carry a
 * generic name without leaking what the file is.
 */
export async function encryptFileBytes(
    bytes: Uint8Array,
    filename: string,
    recipientArmoredKeys: string[],
    signingKey: PrivateKey
): Promise<Uint8Array> {
    const encryptionKeys = await Promise.all(recipientArmoredKeys.map(armoredKey => readKey({ armoredKey })));

    return await encrypt({
        message: await createMessage({ binary: bytes, filename }),
        encryptionKeys,
        signingKeys: signingKey,
        format: "binary"
    }) as Uint8Array;
}

export interface DecryptedFile {
    data: Uint8Array;
    filename: string;
    verified: boolean | null;
}

/** Decrypts encrypted file bytes, recovering the embedded original filename */
export async function decryptFileBytes(
    bytes: Uint8Array,
    privateKey: PrivateKey,
    verificationArmoredKey?: string
): Promise<DecryptedFile> {
    const message = await readMessage({ binaryMessage: bytes });
    const verificationKeys = verificationArmoredKey
        ? await readKey({ armoredKey: verificationArmoredKey })
        : undefined;

    const { data, signatures, filename } = await decrypt({
        message,
        decryptionKeys: privateKey,
        verificationKeys,
        format: "binary"
    }) as { data: Uint8Array; signatures: any[]; filename: string; };

    let verified: boolean | null = null;
    if (verificationKeys && signatures.length > 0) {
        verified = await signatures[0].verified.then(() => true, () => false);
    }

    return { data, filename: filename || "file", verified };
}

/** Decrypts the base64 payload of a "pgp:..." message. Throws if not encrypted to this key. */
export async function decryptMessage(b64: string, privateKey: PrivateKey, verificationArmoredKey?: string): Promise<DecryptedMessage> {
    const message = await readMessage({ binaryMessage: fromBase64(b64) });
    const verificationKeys = verificationArmoredKey
        ? await readKey({ armoredKey: verificationArmoredKey })
        : undefined;

    const { data, signatures } = await decrypt({
        message,
        decryptionKeys: privateKey,
        verificationKeys
    });

    let verified: boolean | null = null;
    if (verificationKeys && signatures.length > 0) {
        verified = await signatures[0].verified.then(() => true, () => false);
    }

    return { text: data as string, verified };
}
