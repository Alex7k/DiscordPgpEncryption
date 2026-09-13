/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ExpandableSection } from "@components/ExpandableCard";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";

/** How the thing works, for people who have never touched PGP before */
function AsymmetricEncryption() {
    return (
        <>
            <Paragraph>
                Anyone can generate themselves a random keypair (private+public key).
                The public key is derived from the private key, but the reverse is impossible.
            </Paragraph>

            <Paragraph className={Margins.top16}>Your private key can:</Paragraph>
            <ul className="vc-pgp-about-list">
                <li>Decrypt messages people encrypt to you</li>
                <li>Sign messages so people know you wrote them</li>
            </ul>

            <Paragraph className={Margins.top8}>Your public key can:</Paragraph>
            <ul className="vc-pgp-about-list">
                <li>Be used by others to encrypt messages that only you can decrypt</li>
                <li>Verify that a message was signed by you</li>
            </ul>

            <Paragraph className={Margins.top16}>
                You don't need your own keypair to encrypt a message to someone.
                You only need it to receive or sign messages.
            </Paragraph>

            <Paragraph className={Margins.top16}>
                The private key should not be shared, but the public key isn't sensitive, so it can be
                shared freely (but make sure to send it through a medium that won't get tampered with).
            </Paragraph>
        </>
    );
}

/** The case for encrypting Discord at all. Collapsed by default: worth reading once, in the way of the settings after that. */
function WhyCare() {
    return (
        <>
            <Heading>Discord is not end-to-end encrypted</Heading>
            <Paragraph>
                Employees, hackers, feds can read your messages. Accidentally leak your session cookie? Whoever has it
                can export every single message you've sent. Data breaches are common and are not always are disclosed.
                You can be accidentally tied into an investigation and find yourself in the scope of a subpoena, even if
                you did nothing wrong.
                Discord retains messages and makes them difficult to delete in bulk.
                Automated systems increasingly evaluate and flag messages at scale. There's no need for a human to read everything.
            </Paragraph>

            <Heading className={Margins.top16}>Everyone has something to protect</Heading>
            <Paragraph>
                Do you trust Discord with every secret and opinion you've ever shared on here?
                Messages stored indefinitely can be pulled out of context years later, and you do not get to
                choose what can be used against you.
            </Paragraph>

            <Heading className={Margins.top16}>Encrypting by default helps those who need it most</Heading>
            <Paragraph>
                Using insecure tools by default normalizes surveillance and makes it harder for others to maintain their privacy.
                Examples of people that depend on privacy: journalists and their sources, abuse victims, people living under
                censorship and anyone who's privacy-conscious. If only high-risk people use encryption, the mere
                act of using it makes them stand out. Privacy works like herd immunity.
            </Paragraph>

            <Heading className={Margins.top16}>Caveats</Heading>
            <Paragraph>
                This plugin encrypts messages and files, but metadata like who you talk to and when still leak.
                Also, link embeds don't work since they usually rely on discord crawling the link.
                When on mobile, you have to use a pgp app to copy and paste into, with your private key imported.
            </Paragraph>

            <Heading className={Margins.top16}>Bottom line</Heading>
            <Paragraph>
                Try to move communication to encrypted mediums like <Link href="https://signal.org">Signal</Link> or similar.
                A single person spreading awareness can also make a huge difference.
                By the way, you can use PGP anywhere with external tools like
                "<Link href="https://kleopatra.app/tools/kleopatra-download">Kleopatra</Link>" (Windows) so you can encrypt
                messages and copy them into any chat application without any plugins.
            </Paragraph>
        </>
    );
}

export function About() {
    return (
        <>
            <ExpandableSection className="vc-pgp-about-section" renderContent={AsymmetricEncryption}>
                <Heading className="vc-pgp-about-section-title">Simple explanation of asymmetric encryption</Heading>
            </ExpandableSection>

            <ExpandableSection className="vc-pgp-about-section" renderContent={WhyCare}>
                <Heading className="vc-pgp-about-section-title">Why care?</Heading>
            </ExpandableSection>

            <Paragraph className={Margins.top16}>
                Source code: <Link href="https://github.com/Alex7k/DiscordPgpEncryption">github.com/Alex7k/DiscordPgpEncryption</Link>
            </Paragraph>
        </>
    );
}
