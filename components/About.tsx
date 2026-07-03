/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";

export function About() {
    return (
        <>
            <Heading>Discord is not end-to-end encrypted</Heading>
            <Paragraph>
                Every message you send on Discord is stored on Discord's servers in a form the company can
                read. Your confidentiality is not in your hands: employees, anyone with a warrant or a
                government request, and whoever obtains the next database leak can read your entire history.
                On top of that, automated systems increasingly evaluate messages at scale, including AI.
                You cannot verify what is kept, scanned, or shared.
            </Paragraph>

            <Heading className={Margins.top16}>Everyone has something to protect</Heading>
            <Paragraph>
                "Nothing to hide" does not hold up. Everyone has secrets: health questions, relationships,
                bad jokes, "unwanted" political opinions. Messages stored forever can be pulled out of
                context years later, and you do not get to choose what looks incriminating to a threat
                actor, an employer, or a keyword filter with no sense of nuance.
            </Paragraph>

            <Heading className={Margins.top16}>Encryption protects the people who need it most</Heading>
            <Paragraph>
                Using insecure tools by default normalizes surveillance, and that harms those who depend on
                safe communication: journalists and their sources, abuse victims, people living under
                censorship and just privacy-valuing people. If only high-risk people use encryption, the mere
                act of using it makes them stand out. When everyone encrypts everyday chatter, nobody stands out.
                Privacy works like herd immunity.
            </Paragraph>

            <Heading className={Margins.top16}>Lipstick on a pig</Heading>
            <Paragraph>
                Even if you use this plugin, the following still gets leaked: metadata (who you talk to, when, how often), stickers, attachments.
                Also, link embeds don't work and obviously the PGP stuff doesn't work when not using the plugin (e.g. on your iOS phone).
                Don't use Discord, use <Link href="https://signal.org">Signal</Link> or similar instead, and get other people to add you on there too.
            </Paragraph>

            <Paragraph className={Margins.top16}>
                Source code: <Link href="https://github.com/Alex7k/DiscordPgpEncryption">github.com/Alex7k/DiscordPgpEncryption</Link>
            </Paragraph>
        </>
    );
}
