/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, TextButton } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { CopyIcon, DownArrow, RightArrow } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import { useAwaiter } from "@utils/react";
import { Alerts, Clickable, showToast, TextArea, TextInput, useEffect, useRef, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { formatFingerprint, generateKeyPair, prepareKeyImport } from "../crypto";
import { clearContacts, deleteOwnKey, getContacts, getOwnKey, isUnlocked, lock, onContactsChange, onKeyChange, OwnKeyRecord, removeContact, setOwnKey } from "../keyStore";
import { forgetPassphrase, hasRememberedPassphrase } from "../rememberedPassphrase";
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

/**
 * A collapsed row in the same clothes as Vencord's ExpandableSection (whose
 * stylesheet About.tsx already loads). Rolled by hand so the content can be
 * plain JSX with props: ExpandableSection takes a component type and remounts
 * the content whenever the parent re-renders with a fresh render function,
 * which would wipe a half-pasted key backup every time the lock state changes.
 */
function CollapsibleSection({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode; }) {
    const [expanded, setExpanded] = useState(false);
    const Arrow = expanded ? DownArrow : RightArrow;

    return (
        <Card data-expanded={expanded} className="vc-expandable-card vc-pgp-about-section vc-pgp-collapsible">
            <Clickable className="vc-expandable-card-header" onClick={() => setExpanded(e => !e)}>
                <div>
                    <Heading className="vc-pgp-about-section-title">{title}</Heading>
                    <Paragraph className="vc-pgp-collapsed-sub" size="xs" style={mutedText}>{subtitle}</Paragraph>
                </div>
                <Arrow className="vc-expandable-card-icon" />
            </Clickable>
            {expanded && <div className="vc-expandable-card-content">{children}</div>}
        </Card>
    );
}

function KeyIcon() {
    return (
        <svg className="vc-pgp-keycard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="15" r="4" />
            <path d="M10.85 12.15 19 4" />
            <path d="M18 5l2 2" />
            <path d="M15 8l2 2" />
        </svg>
    );
}

/**
 * The card frame every keypair state shares, so the section keeps its place
 * and shape whether there is a key, a locked key, or none yet.
 */
function KeypairCard({ status, children }: { status: "unlocked" | "locked" | "none"; children: ReactNode; }) {
    const pill = status === "unlocked"
        ? <span className="vc-pgp-pill vc-pgp-pill-on"><span className="vc-pgp-pill-dot" />Unlocked</span>
        : status === "locked"
            ? <span className="vc-pgp-pill vc-pgp-pill-off">Locked</span>
            : <span className="vc-pgp-pill vc-pgp-pill-off">No keypair yet</span>;

    return (
        <Card className="vc-pgp-keycard">
            <div className="vc-pgp-keycard-head">
                <div className="vc-pgp-keycard-title"><KeyIcon />My keypair</div>
                {pill}
            </div>
            <div className="vc-pgp-keycard-body">
                {children}
            </div>
        </Card>
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
        <KeypairCard status="none">
            <Paragraph>
                Generate one to start sending and receiving encrypted messages.
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
        </KeypairCard>
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
            <Paragraph className="vc-pgp-settings-help" size="xs" style={mutedText}>
                Paste a private key backup (the "-----BEGIN PGP PRIVATE KEY BLOCK-----" text created by
                "Back Up Private Key" on your other device) and enter the passphrase that unlocks it.
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
                showToast("Private key locked and saved passphrase forgotten");
            } else {
                showToast("Private key locked");
            }
        } else {
            const key = await ensureUnlocked();
            if (key) showToast("Private key unlocked for this session");
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

    const fingerprint = formatFingerprint(record.fingerprint);

    return (
        <KeypairCard status={isUnlocked() ? "unlocked" : "locked"}>
            <dl className="vc-pgp-facts">
                <dt>Name</dt>
                <dd>{record.userName}</dd>

                <dt>Fingerprint</dt>
                <dd className="vc-pgp-facts-fingerprint">
                    <code>{fingerprint}</code>
                    <Button
                        size="iconOnly"
                        variant="none"
                        className="vc-pgp-icon-btn"
                        aria-label="Copy fingerprint"
                        onClick={() => copyWithToast(fingerprint, "Fingerprint copied!")}
                    >
                        <CopyIcon width={16} height={16} />
                    </Button>
                </dd>

                <dt>Created</dt>
                <dd>{new Date(record.createdAt).toLocaleDateString()}</dd>

                <dt>Passphrase</dt>
                <dd>
                    {remembered
                        ? <>Remembered on this device{" "}<TextButton variant="link" className="vc-pgp-inline-btn" onClick={forgetSaved}>Forget</TextButton></>
                        : "Asked once per Discord session"}
                </dd>
            </dl>

            <div className="vc-pgp-keycard-actions">
                <Button size="small" onClick={() => copyWithToast(record.publicKey, "Public key copied!")}>
                    Copy Public Key
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => copyWithToast(record.privateKey, "Encrypted private key copied. Store it somewhere safe!")}
                >
                    Back Up Private Key
                </Button>
                <Button size="small" variant="secondary" onClick={toggleLock}>
                    {isUnlocked() ? "Lock" : "Unlock"}
                </Button>
                <span className="vc-pgp-keycard-spacer" />
                <TextButton variant="danger" onClick={confirmDelete}>
                    Delete keypair
                </TextButton>
            </div>

            <Paragraph size="xs" style={mutedText}>
                Keep a backup of the private key and its passphrase, for example in a password manager.
                Without one, losing this key means every message encrypted to it stays unreadable.
                On another device, import that backup rather than generating a second key.
            </Paragraph>
        </KeypairCard>
    );
}

function ContactsSection() {
    const [nonce, setNonce] = useState(0);
    const rerender = () => setNonce(n => n + 1);
    // imports from the chat, removals here, and the reset at the bottom of the page
    useEffect(() => { const off = onContactsChange(rerender); return () => void off(); }, []);

    const [contacts] = useAwaiter(getContacts, {
        fallbackValue: {},
        deps: [nonce]
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

    const subtitle = entries.length === 0
        ? "No imported keys yet."
        : `${entries.length} imported ${entries.length === 1 ? "key" : "keys"}.`;

    return (
        <CollapsibleSection title="Trusted contacts" subtitle={subtitle}>
            {entries.length === 0
                ? (
                    <Paragraph className="vc-pgp-settings-help" size="xs" style={mutedText}>
                        When someone shares their public key in a DM, click the "import" button
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
        </CollapsibleSection>
    );
}

export function KeySettings() {
    const [reloadCount, setReloadCount] = useState(0);
    const reload = () => setReloadCount(c => c + 1);
    // unlock, generate, import, delete, and the reset at the bottom of the page all land here
    useEffect(() => { const off = onKeyChange(reload); return () => void off(); }, []);

    const [ownKey, , loading] = useAwaiter(getOwnKey, {
        fallbackValue: undefined,
        deps: [reloadCount]
    });

    // only the first load hides the section; later reloads keep the mounted
    // forms (and whatever is typed into them) while the key record refreshes
    const everLoaded = useRef(false);
    if (!loading) everLoaded.current = true;
    if (!everLoaded.current) return null;

    return (
        <>
            {ownKey
                ? <KeyInfo record={ownKey} onChanged={reload} />
                : <GenerateKeyForm onGenerated={reload} />
            }

            <CollapsibleSection
                title="Import an existing keypair"
                subtitle="Restore a backup from another device. Replaces the keypair above."
            >
                <ImportKeyForm hasExisting={ownKey != null} onImported={reload} />
            </CollapsibleSection>

            <ContactsSection />
        </>
    );
}
