/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ApplicationAssetUtils, FluxDispatcher, IconUtils, UserStore } from "@webpack/common";

enum StatsDisplay {
    MessagesSentToday,
    MessagesSentAllTime
}

export async function getApplicationAsset(key: string): Promise<string> {
    if (/https?:\/\/(cdn|media)\.discordapp\.(com|net)\/attachments\//.test(key))
        return "mp:" + key.replace(/https?:\/\/(cdn|media)\.discordapp\.(com|net)\//, "");
    return (await ApplicationAssetUtils.fetchAssetIds("0", [key]))[0];
}

const settings = definePluginSettings({
    assetURL: {
        type: OptionType.STRING,
        description: "The image to use for your RPC. Your profile picture is used if left blank.",
        default: "",
        restartNeeded: false,
        onChange: () => updateData()
    },
    RPCTitle: {
        type: OptionType.STRING,
        description: "The title for the RPC.",
        default: "RPCStats",
        restartNeeded: false,
        onChange: () => updateData()
    },
    statDisplay: {
        type: OptionType.SELECT,
        description: "What should the RPC display?",
        options: [
            { value: StatsDisplay.MessagesSentToday, label: "The amount of messages sent today", default: true },
            { value: StatsDisplay.MessagesSentAllTime, label: "The amount of messages sent all time" }
        ],
        restartNeeded: false,
        onChange: () => updateData()
    }
});

async function setRpc(disable = false, details?: string) {
    if (disable) {
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: null,
            socketId: "RPCStats",
        });
        return;
    }

    const fallbackImage = settings.store.assetURL
        || IconUtils.getUserAvatarURL(UserStore.getCurrentUser(), false, 128)
        || IconUtils.getDefaultAvatarURL(UserStore.getCurrentUser().id);

    const activity = {
        application_id: "0",
        name: settings.store.RPCTitle,
        details: details || "No info right now :(",
        type: 0,
        flags: 1,
        assets: {
            large_image: await getApplicationAsset(fallbackImage)
        }
    };

    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: "RPCStats",
    });
}

function getCurrentDate(): string {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

async function incrementStat(key: string): Promise<number> {
    const current = (await DataStore.get(key)) ?? 0;
    const nextValue = current + 1;
    await DataStore.set(key, nextValue);
    return nextValue;
}

interface IMessageCreate {
    type: "MESSAGE_CREATE";
    optimistic: boolean;
    isPushNotification: boolean;
    channelId: string;
    message: Message;
}

let intervalId: NodeJS.Timeout;
let lastCheckedDate: string = getCurrentDate();

async function updateData() {
    switch (settings.store.statDisplay) {
        case StatsDisplay.MessagesSentToday: {
            const todayStr = getCurrentDate();
            if (await DataStore.get("RPCStatsDate") !== todayStr) {
                await DataStore.set("RPCStatsDate", todayStr);
                await DataStore.set("RPCStatsMessages", 0);
            }
            const messagesSent = (await DataStore.get("RPCStatsMessages")) ?? 0;
            setRpc(false, `Messages sent today: ${messagesSent}`);
            break;
        }

        case StatsDisplay.MessagesSentAllTime: {
            const messagesAllTime = (await DataStore.get("RPCStatsAllTimeMessages")) ?? 0;
            setRpc(false, `Messages sent all time: ${messagesAllTime}`);
            break;
        }
    }
}

async function checkForNewDay() {
    const currentDate = getCurrentDate();
    if (currentDate !== lastCheckedDate) {
        lastCheckedDate = currentDate;
        await DataStore.set("RPCStatsDate", currentDate);
        await DataStore.set("RPCStatsMessages", 0);
        updateData();
    }
}

export default definePlugin({
    name: "RPCStats",
    description: "Displays stats about your activity as an RPC",
    tags: ["Utility"],
    authors: [Devs.Samwich],

    async start() {
        await updateData();

        intervalId = setInterval(async () => {
            await checkForNewDay();
            await updateData();
        }, 60000);
    },

    settings,

    stop() {
        clearInterval(intervalId);
        setRpc(true);
    },

    flux: {
        async MESSAGE_CREATE({ optimistic, type, message }: IMessageCreate) {
            if (optimistic || type !== "MESSAGE_CREATE") return;
            if (message.state === "SENDING") return;
            if (message.author.id !== UserStore.getCurrentUser().id) return;

            const todayStr = getCurrentDate();
            if (await DataStore.get("RPCStatsDate") !== todayStr) {
                await DataStore.set("RPCStatsDate", todayStr);
                await DataStore.set("RPCStatsMessages", 0);
            }

            await incrementStat("RPCStatsMessages");
            await incrementStat("RPCStatsAllTimeMessages");

            updateData();
        },
    }
});
