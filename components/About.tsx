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
                read. Your confidentiality is not in your hands: employees, governments, and whoever obtains
                the next database leak can read your entire history.
                On top of that, automated systems increasingly evaluate messages at scale.
                You cannot verify what is kept, scanned, or shared. Deleting messages is useless.
            </Paragraph>

            <Heading className={Margins.top16}>Everyone has something to protect</Heading>
            <Paragraph>
                Everyone has secrets: relationships, nuanced jokes, "unwanted" political opinions.
                Messages stored indefinitely can be pulled out of context years later, and you do not get to
                choose what looks incriminating to a threat actor, an employer, or a keyword filter.
                They don't need to manually read all of your chatlogs, they can just use AI to
                find the most "problematic"-sounding chats effortlessly.
            </Paragraph>

            <Heading className={Margins.top16}>Encryption protects the people who need it most</Heading>
            <Paragraph>
                Using insecure tools by default normalizes surveillance, and that harms those who depend on
                safe communication: journalists and their sources, abuse victims, people living under
                censorship and anyone who's privacy-conscious. If only high-risk people use encryption, the mere
                act of using it makes them stand out. Privacy works like herd immunity.
            </Paragraph>

            <Heading className={Margins.top16}>Not a perfect solution</Heading>
            <Paragraph>
                Even if you use this plugin, metadata (who you talk to, when, how often) and stickers still get leaked.
                Also, link embeds don't work (they rely on discord's bots fetching those links, but discord doesn't see the links obviously)
                and of course, the PGP stuff doesn't work when not using the plugin.
            </Paragraph>

            <Heading className={Margins.top16}>Bottom line</Heading>
            <Paragraph>
                Don't use Discord, use <Link href="https://signal.org">Signal</Link> or similar, and get others to switch as well.
            </Paragraph>

            <Paragraph className={Margins.top16}>
                Source code: <Link href="https://github.com/Alex7k/DiscordPgpEncryption">github.com/Alex7k/DiscordPgpEncryption</Link>
            </Paragraph>
        </>
    );
}
