/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import { useAwaiter } from "@utils/react";
import { Alerts, showToast, TextArea, TextInput, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { formatFingerprint, generateKeyPair, prepareKeyImport } from "../crypto";
import { clearContacts, deleteOwnKey, getContacts, getOwnKey, isUnlocked, lock, OwnKeyRecord, removeContact, setOwnKey } from "../keyStore";
import { forgetPassphrase, hasRememberedPassphrase } from "../rememberedPassphrase";
import { clearEnabledChannels, clearMessageState } from "../state";
import { openBackupModal } from "./BackupModal";
import { ensureUnlocked } from "./UnlockModal";

const mutedText = { color: "var(--text-muted)" } as const;
const errorText = { color: "var(--status-danger, #f23f43)" } as const;

function SettingsField({ title, description, className, children }: {
    title: string;
    description?: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={className ? `vc-pgp-settings-field ${className}` : "vc-pgp-settings-field"}>
            <Heading className="vc-pgp-settings-label">{title}</Heading>
            {description && (
                <Paragraph className="vc-pgp-settings-help" size="xs" style={mutedText}>
                    {description}
                </Paragraph>
            )}
            {children}
        </div>
    );
}

function GenerateKeyForm({ onGenerated }: { onGenerated: () => void; }) {
    const [userName, setUserName] = useState(() => UserStore.getCurrentUser()?.username ?? "");
    const [passphrase, setPassphrase] = useState("");
    const [confirm, setConfirm] = useState("");
    const [busy, setBusy] = useState(false);

    const mismatch = confirm !== "" && passphrase !== confirm;
    const canGenerate = userName !== "" && passphrase !== "" && passphrase === confirm && !busy;

    async function generate() {
        setBusy(true);
        try {
            const { publicKey, privateKey, fingerprint } = await generateKeyPair(userName, passphrase);
            const record: OwnKeyRecord = {
                publicKey,
                privateKey,
                fingerprint,
                userName,
                createdAt: Date.now()
            };
            await setOwnKey(record);
            showToast("PGP keypair generated!");
            onGenerated();
            openBackupModal(record);
        } catch (e) {
            showToast(`Failed to generate keypair: ${e}`);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Paragraph>
                You don't have a PGP keypair yet. Generate one to start sending and receiving encrypted messages.
                The private key is stored encrypted with your passphrase and unlocked once per Discord session.
            </Paragraph>
            <Paragraph className={Margins.top8} size="xs" style={mutedText}>
                Already using this plugin on another device? Don't generate a second key. Import your existing
                keypair below so all your devices share one identity.
            </Paragraph>

            <div className="vc-pgp-settings-fields">
                <SettingsField title="Key name" description="Embedded in the key so contacts can identify it">
                    <TextInput
                        value={userName}
                        onChange={setUserName}
                    />
                </SettingsField>

                <SettingsField title="Passphrase">
                    <TextInput
                        type="password"
                        value={passphrase}
                        onChange={setPassphrase}
                    />
                </SettingsField>

                <SettingsField title="Confirm passphrase">
                    <TextInput
                        type="password"
                        value={confirm}
                        onChange={setConfirm}
                        error={mismatch ? "Passphrases do not match" : undefined}
                    />
                </SettingsField>
            </div>

            <Paragraph className="vc-pgp-settings-note" size="xs" style={mutedText}>
                There is no way to recover a lost passphrase. If you lose it, you lose access to all messages
                encrypted to this key.
            </Paragraph>

            <Button
                className="vc-pgp-settings-button"
                disabled={!canGenerate}
                onClick={generate}
            >
                {busy ? "Generating..." : "Generate Keypair"}
            </Button>
        </>
    );
}

function ImportKeyForm({ hasExisting, onImported }: { hasExisting: boolean; onImported: () => void; }) {
    const [armored, setArmored] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const canImport = armored.trim() !== "" && passphrase !== "" && !busy;

    async function doImport() {
        setBusy(true);
        setError(null);
        try {
            const prepared = await prepareKeyImport(armored, passphrase);
            // drop the old session key and any remembered passphrase; they belong to the old keypair
            await forgetPassphrase();
            lock();
            await setOwnKey({
                publicKey: prepared.publicKey,
                privateKey: prepared.privateKey,
                fingerprint: prepared.fingerprint,
                userName: prepared.userName,
                createdAt: Date.now()
            });
            showToast(`Imported PGP keypair (${formatFingerprint(prepared.fingerprint).slice(0, 24)}...)`);
            setArmored("");
            setPassphrase("");
            onImported();
        } catch (e: any) {
            setError(String(e?.message ?? e));
        } finally {
            setBusy(false);
        }
    }

    function confirmImport() {
        if (!hasExisting) {
            void doImport();
            return;
        }

        Alerts.show({
            title: "Replace current keypair?",
            body: "Importing replaces the keypair currently on this device. Unless you have a backup of the current key, "
                + "messages encrypted to it will become permanently unreadable. Your imported contacts stay untouched.",
            confirmText: "Replace",
            cancelText: "Cancel",
            onConfirm: doImport
        });
    }

    return (
        <>
            <Heading className="vc-pgp-settings-section-title">Import an existing keypair</Heading>
            <Paragraph className="vc-pgp-settings-help" size="xs" style={mutedText}>
                Paste a private key backup (the "-----BEGIN PGP PRIVATE KEY BLOCK-----" text created by
                "Backup Private Key" on your other device) and enter the passphrase that unlocks it.
                If you paste an unprotected key, it will be locked with the passphrase you enter here.
            </Paragraph>

            <div className="vc-pgp-settings-textarea">
                <TextArea
                    value={armored}
                    onChange={setArmored}
                    rows={6}
                />
            </div>

            <SettingsField title="Key passphrase" className="vc-pgp-settings-field-after-control">
                <TextInput
                    type="password"
                    value={passphrase}
                    onChange={setPassphrase}
                />
            </SettingsField>

            {error !== null && (
                <Paragraph className={Margins.top8} size="xs" style={errorText}>
                    Import failed: {error}
                </Paragraph>
            )}

            <Button
                className="vc-pgp-settings-button"
                variant={hasExisting ? "dangerPrimary" : "primary"}
                disabled={!canImport}
                onClick={confirmImport}
            >
                {busy ? "Importing..." : hasExisting ? "Import & Replace Keypair" : "Import Keypair"}
            </Button>
        </>
    );
}

function KeyInfo({ record, onChanged }: { record: OwnKeyRecord; onChanged: () => void; }) {
    // Lock state and the remembered passphrase live outside React; nonce forces re-renders
    const [nonce, setNonce] = useState(0);
    const rerender = () => setNonce(n => n + 1);

    const [remembered] = useAwaiter(hasRememberedPassphrase, {
        fallbackValue: false,
        deps: [nonce]
    });

    async function toggleLock() {
        if (isUnlocked()) {
            lock();
            // A remembered passphrase would silently undo the lock on next startup
            if (await hasRememberedPassphrase()) {
                await forgetPassphrase();
                showToast("PGP key locked and saved passphrase forgotten");
            } else {
                showToast("PGP key locked");
            }
        } else {
            const key = await ensureUnlocked();
            if (key) showToast("PGP key unlocked for this session");
        }
        rerender();
    }

    async function forgetSaved() {
        await forgetPassphrase();
        showToast("Saved passphrase forgotten. You'll be asked for it again next session.");
        rerender();
    }

    function confirmDelete() {
        Alerts.show({
            title: "Delete PGP keypair?",
            body: "You will permanently lose the ability to decrypt any messages encrypted to this key, unless you have a backup. This cannot be undone.",
            confirmText: "Delete",
            cancelText: "Cancel",
            onConfirm: async () => {
                await forgetPassphrase();
                await deleteOwnKey();
                showToast("PGP keypair deleted");
                onChanged();
            }
        });
    }

    return (
        <>
            <Heading>Fingerprint</Heading>
            <Paragraph style={{ fontFamily: "var(--font-code)", userSelect: "text" }}>
                {formatFingerprint(record.fingerprint)}
            </Paragraph>

            <Paragraph className={Margins.top8} size="xs" style={mutedText}>
                {record.userName} · created {new Date(record.createdAt).toLocaleDateString()} · {isUnlocked() ? "🔓 unlocked" : "🔒 locked"}{remembered ? " · passphrase remembered on this device" : ""}
            </Paragraph>

            <Flex className={Margins.top16} style={{ gap: "0.5em", flexWrap: "wrap" }}>
                <Button size="small" onClick={() => copyWithToast(record.publicKey, "Public key copied!")}>
                    Copy Public Key
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => copyWithToast(record.privateKey, "Encrypted private key copied. Store it somewhere safe!")}
                >
                    Backup Private Key
                </Button>
                <Button size="small" variant="secondary" onClick={toggleLock}>
                    {isUnlocked() ? "Lock" : "Unlock"}
                </Button>
                {remembered && (
                    <Button size="small" variant="secondary" onClick={forgetSaved}>
                        Forget Saved Passphrase
                    </Button>
                )}
                <Button size="small" variant="dangerPrimary" onClick={confirmDelete}>
                    Delete Keypair
                </Button>
            </Flex>

            <Heading className={Margins.top16}>⚠ BACK UP THE KEY + PASSPHRASE!</Heading>
            <Paragraph size="xs" style={mutedText}>
                Click "Backup Private Key" above. Store the private key AND passphrase somewhere safe, such as a password manager.
                If you delete or lose the keypair without a backup, every message ever encrypted to this key becomes permanently unreadable.
            </Paragraph>
            <Paragraph className={Margins.top8} size="xs" style={mutedText}>
                Using Discord on several devices? Do NOT generate a second key. Import this same backup on each
                device instead (below, under "Import an existing keypair"). Contacts encrypt to exactly one key
                per account, so only devices holding this key can read your messages.
            </Paragraph>
        </>
    );
}

function ContactsPanel({ reloadToken }: { reloadToken: number; }) {
    const [nonce, setNonce] = useState(0);
    const rerender = () => setNonce(n => n + 1);

    const [contacts] = useAwaiter(getContacts, {
        fallbackValue: {},
        deps: [nonce, reloadToken]
    });
    const entries = Object.entries(contacts ?? {});

    async function remove(userId: string) {
        await removeContact(userId);
        rerender();
    }

    function confirmForgetAll() {
        Alerts.show({
            title: "Forget all trusted keys?",
            body: "Every contact's imported public key is removed. You can no longer send them encrypted "
                + "messages or verify their signatures until they share their key again and you re-import it.",
            confirmText: "Forget all",
            cancelText: "Cancel",
            onConfirm: async () => {
                await clearContacts();
                showToast("All trusted contact keys forgotten");
                rerender();
            }
        });
    }

    return (
        <>
            <Heading className="vc-pgp-settings-section-title">Trusted contacts</Heading>
            {entries.length === 0
                ? (
                    <Paragraph className="vc-pgp-settings-help" size="xs" style={mutedText}>
                        No imported keys yet. When someone shares their public key in a DM, click the "import" button
                        and it will show up here.
                    </Paragraph>
                )
                : entries.map(([userId, record]) => (
                    <Flex
                        key={userId}
                        className={Margins.top8}
                        style={{ gap: "0.5em", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
                    >
                        <div>
                            <Paragraph>
                                {UserStore.getUser(userId)?.username ?? userId}
                                <span style={mutedText}> · imported {new Date(record.importedAt).toLocaleDateString()}</span>
                            </Paragraph>
                            <Paragraph size="xs" style={{ ...mutedText, fontFamily: "var(--font-code)", userSelect: "text" }}>
                                {formatFingerprint(record.fingerprint)}
                            </Paragraph>
                        </div>
                        <Button size="small" variant="secondary" onClick={() => void remove(userId)}>
                            Remove
                        </Button>
                    </Flex>
                ))}
            {entries.length > 1 && (
                <Button className="vc-pgp-settings-button" size="small" variant="dangerPrimary" onClick={confirmForgetAll}>
                    Forget All Contacts
                </Button>
            )}
        </>
    );
}

function ResetPanel({ onChanged }: { onChanged: () => void; }) {
    function confirmReset() {
        Alerts.show({
            title: "Reset all plugin data?",
            body: "Deletes your keypair, every trusted contact key, the saved passphrase, and all per-channel "
                + "encryption toggles on this device. Unless you have a key backup, messages encrypted to this "
                + "key become permanently unreadable. This cannot be undone.",
            confirmText: "Reset everything",
            cancelText: "Cancel",
            onConfirm: async () => {
                await forgetPassphrase();
                await deleteOwnKey();
                await clearContacts();
                await clearEnabledChannels();
                clearMessageState();
                showToast("All PgpEncrypt data wiped. Restart Discord for a clean slate.");
                onChanged();
            }
        });
    }

    return (
        <>
            {/* <Heading className="vc-pgp-settings-section-title">Reset</Heading> */}
            <Button className="vc-pgp-settings-button" variant="dangerPrimary" onClick={confirmReset}>
                Reset Plugin Data
            </Button>
        </>
    );
}

export function KeySettings() {
    const [reloadCount, setReloadCount] = useState(0);
    const reload = () => setReloadCount(c => c + 1);

    const [ownKey, , loading] = useAwaiter(getOwnKey, {
        fallbackValue: undefined,
        deps: [reloadCount]
    });

    if (loading) return null;

    return (
        <>
            {ownKey
                ? <KeyInfo record={ownKey} onChanged={reload} />
                : <GenerateKeyForm onGenerated={reload} />
            }
            <Divider className="vc-pgp-settings-divider" />
            <ImportKeyForm hasExisting={ownKey != null} onImported={reload} />
            <Divider className="vc-pgp-settings-divider" />
            <ContactsPanel reloadToken={reloadCount} />
            <Divider className="vc-pgp-settings-divider" />
            <ResetPanel onChanged={reload} />
        </>
    );
}
