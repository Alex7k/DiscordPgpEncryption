/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import type { PrivateKey } from "openpgp";

import { unlockPrivateKey } from "./crypto";

const OWN_KEY = "PgpEncrypt_ownKey";
const CONTACTS = "PgpEncrypt_contacts";

export interface OwnKeyRecord {
    /** Armored public key */
    publicKey: string;
    /** Armored private key, locked with the user's passphrase */
    privateKey: string;
    fingerprint: string;
    userName: string;
    createdAt: number;
}

export interface ContactRecord {
    /** Armored public key */
    publicKey: string;
    fingerprint: string;
    importedAt: number;
}

export const getOwnKey = () => DataStore.get<OwnKeyRecord>(OWN_KEY);

export async function setOwnKey(record: OwnKeyRecord) {
    await DataStore.set(OWN_KEY, record);
    // a fresh or restored keypair may make previously undecryptable messages readable
    for (const listener of keyListeners) listener();
}

export async function deleteOwnKey() {
    await DataStore.del(OWN_KEY);
    lock();
}

/** Contact public keys, keyed by Discord user id */
export const getContacts = async () =>
    await DataStore.get<Record<string, ContactRecord>>(CONTACTS) ?? {};

export async function setContact(userId: string, record: ContactRecord) {
    const contacts = await getContacts();
    contacts[userId] = record;
    await DataStore.set(CONTACTS, contacts);
}

export async function removeContact(userId: string) {
    const contacts = await getContacts();
    delete contacts[userId];
    await DataStore.set(CONTACTS, contacts);
}

// The decrypted private key is only ever held in memory, never persisted
let sessionKey: PrivateKey | null = null;

const keyListeners = new Set<() => void>();

/** Register a callback fired whenever the private key is unlocked or the keypair changes */
export function onKeyChange(listener: () => void) {
    keyListeners.add(listener);
    return () => keyListeners.delete(listener);
}

export const isUnlocked = () => sessionKey !== null;
export const getSessionKey = () => sessionKey;

export function lock() {
    sessionKey = null;
}

/** Throws if no keypair exists or the passphrase is wrong */
export async function unlockWithPassphrase(passphrase: string): Promise<PrivateKey> {
    const record = await getOwnKey();
    if (!record) throw new Error("No PGP keypair has been generated yet");

    sessionKey = await unlockPrivateKey(record.privateKey, passphrase);
    for (const listener of keyListeners) listener();
    return sessionKey;
}
