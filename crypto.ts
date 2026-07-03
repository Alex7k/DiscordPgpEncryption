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

export interface DecryptedMessage {
    text: string;
    /** true/false if the sender's key was available to check the signature, null if not */
    verified: boolean | null;
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
