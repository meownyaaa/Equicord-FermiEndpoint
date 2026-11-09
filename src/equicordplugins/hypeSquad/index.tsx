/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { BaseText } from "@components/BaseText";
import { Button, TextButton } from "@components/Button";
import { ShieldIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { classes, removeFromArray } from "@utils/misc";
import definePlugin from "@utils/types";
import { openModal, RestAPI, UserStore, useState, useStateFromStores } from "@webpack/common";

import { HouseQuizModal, setManaBaseRadioGroup } from "./HouseQuizModal";
import { cl, houseOf, HOUSES, HYPESQUAD_ONLINE, PATTERN, PERKS } from "./houses";

const openQuiz = () => openModal(props => <HouseQuizModal modalProps={props} />);

function HypeSquadTab() {
    const house = useStateFromStores([UserStore], () => houseOf(UserStore.getCurrentUser().flags));
    const [leaving, setLeaving] = useState(false);
    const [leaveFailed, setLeaveFailed] = useState(false);

    const leave = async () => {
        setLeaving(true);
        try {
            await RestAPI.del({ url: HYPESQUAD_ONLINE });
            setLeaveFailed(false);
        } catch {
            setLeaveFailed(true);
        }
        setLeaving(false);
    };

    return (
        <div className={cl("tab")}>
            <div className={cl("intro")}>
                <div className={cl("intro-header")}>{house ? "You're in HypeSquad!" : "Join the HypeSquad!"}</div>
                <div className={cl("intro-blurb")}>You're excited about Discord. We're excited that you're excited about Discord. Let's get other people excited about Discord, together.</div>
            </div>

            {house ? (
                <div className={classes(cl("membership"), cl(`house-${house}`))}>
                    <img className={cl("pattern")} src={PATTERN} alt="" />
                    <div className={cl("membership-content")}>
                        <div className={cl("membership-row")}>
                            <div>
                                <BaseText className={cl("your-house")} size="sm">Your House:</BaseText>
                                <BaseText className={cl("house-name")} weight="semibold">House of {HOUSES[house].name}</BaseText>
                                <BaseText className={cl("house-description")}>{HOUSES[house].description}</BaseText>
                            </div>
                            <div className={cl("logo-wrapper")}>
                                <img className={cl("logo")} src={HOUSES[house].logo} alt={`House of ${HOUSES[house].name}`} />
                            </div>
                        </div>
                        <BaseText className={cl("switch")}>
                            Wanna switch houses?
                            <TextButton className={cl("switch-action")} onClick={openQuiz}>Take the test again</TextButton>
                        </BaseText>
                    </div>
                </div>
            ) : (
                <div className={cl("join")}>
                    <div className={cl("join-row")}>
                        <BaseText>Ready to rep Discord?</BaseText>
                        <Button onClick={openQuiz}>Join HypeSquad</Button>
                    </div>
                    <BaseText className={cl("newsletter")} size="sm">Wumpus’ lawyers wanted us to let you know that joining the HypeSquad will sign you up for our newsletter.</BaseText>
                </div>
            )}

            <div className={cl("perks")}>
                <BaseText className={cl("perks-heading")} weight="bold">Perks of being hype</BaseText>
                {PERKS.map(({ icon, title, description }) => (
                    <div key={title} className={cl("perk")}>
                        <img className={cl("perk-icon")} src={icon} alt="" />
                        <div>
                            <div className={cl("perk-title")}>{title}</div>
                            <div className={cl("perk-description")}>{description}</div>
                        </div>
                    </div>
                ))}
            </div>

            {house ? (
                <div className={cl("leave")}>
                    {leaveFailed ? <BaseText className={cl("leave-error")} size="sm">There was an error removing you from HypeSquad Online. Please try again.</BaseText> : null}
                    <BaseText size="sm">
                        Don't want to be hype anymore?
                        <TextButton className={cl("leave-action")} variant="link" disabled={leaving} onClick={leave}>Leave the HypeSquad</TextButton>
                    </BaseText>
                </div>
            ) : null}
        </div>
    );
}

export default definePlugin({
    name: "HypeSquad",
    description: "Brings back the 2019 HypeSquad settings page and house quiz.",
    authors: [],

    patches: [
        {
            find: '"data-mana-component":"BaseRadioGroup"',
            replacement: {
                match: /(?=function (\i)\(\i\)\{.{0,400}"data-mana-component":"BaseRadioGroup")/,
                replace: "$self.ManaBaseRadioGroup=$1;"
            }
        }
    ],

    set ManaBaseRadioGroup(value: Parameters<typeof setManaBaseRadioGroup>[0]) {
        setManaBaseRadioGroup(value);
    },

    start() {
        SettingsPlugin.customEntries.push({
            key: "equicord_hypesquad",
            title: "HypeSquad",
            Component: HypeSquadTab,
            Icon: ShieldIcon
        });
    },

    stop() {
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "equicord_hypesquad");
    }
});
