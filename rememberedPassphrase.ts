/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { unlockWithPassphrase } from "./keyStore";

const WRAP_KEY = "PgpEncrypt_wrapKey";
const REMEMBERED = "PgpEncrypt_rememberedPassphrase";

const logger = new Logger("PgpEncrypt", "#7289da");

interface RememberedBlob {
    iv: Uint8Array<ArrayBuffer>;
    data: Uint8Array<ArrayBuffer>;
}

/**
 * The wrapping key is a non-extractable WebCrypto key: scripts can use it while
 * the page runs, but its raw bits can never be exported. Copying the DataStore
 * contents alone therefore doesn't reveal the passphrase; protection roughly
 * equivalent to how the Discord auth token is stored.
 */
async function getOrCreateWrapKey(): Promise<CryptoKey> {
    const existing = await DataStore.get<CryptoKey>(WRAP_KEY);
    if (existing) return existing;

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await DataStore.set(WRAP_KEY, key);
    return key;
}

export async function rememberPassphrase(passphrase: string) {
    const key = await getOrCreateWrapKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(passphrase))
    );
    await DataStore.set(REMEMBERED, { iv, data } satisfies RememberedBlob);
}

export async function hasRememberedPassphrase() {
    return await DataStore.get(REMEMBERED) != null;
}

export async function forgetPassphrase() {
    await DataStore.del(REMEMBERED);
    await DataStore.del(WRAP_KEY);
}

let lastAttempt: Promise<boolean> = Promise.resolve(false);

/**
 * Resolves once the auto-unlock attempt currently in flight (if any) has
 * settled, so callers can hold off on "key is locked" nagging during startup.
 */
export function autoUnlockSettled(): Promise<boolean> {
    return lastAttempt;
}

/** Silently unlocks from the remembered passphrase, if any. Returns true on success. */
export function tryAutoUnlock(): Promise<boolean> {
    return lastAttempt = doAutoUnlock();
}

async function doAutoUnlock(): Promise<boolean> {
    try {
        const blob = await DataStore.get<RememberedBlob>(REMEMBERED);
        if (!blob) return false;

        const key = await DataStore.get<CryptoKey>(WRAP_KEY);
        if (!key) {
            await forgetPassphrase();
            return false;
        }

        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv }, key, blob.data);
        await unlockWithPassphrase(new TextDecoder().decode(plain));
        return true;
    } catch (e) {
        // wrap key or keypair changed underneath us; a stale copy is useless, drop it
        logger.info("Auto-unlock failed, clearing remembered passphrase", e);
        await forgetPassphrase();
        return false;
    }
}
