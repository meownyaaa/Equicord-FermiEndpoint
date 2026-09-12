/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Card } from "@components/Card";
import { DoubleCheckmarkIcon, PlusIcon, WebsiteIcon } from "@components/Icons";
import { HeadingPrimary, HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings";
import { PREDEFINED_SERVERS } from "@equicordplugins/ChangeEndpoint/servers";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { Alerts, Button, React, TextInput, useState } from "@webpack/common";

import { settings } from "../settings";

const SETTING_KEYS = ["backend", "customBackendHost", "customApiEndpoint", "customCdnHost", "customGatewayEndpoint", "customMediaProxyEndpoint"] as const;

function confirmRestart() {
    Alerts.show({
        title: "Restart Required",
        body: <p style={{ textAlign: "center" }}>ChangeEndpoint needs a restart to connect to the new server.</p>,
        confirmText: "Restart Now",
        cancelText: "Later",
        onConfirm: () => location.reload()
    });
}

function activeServerLabel(): { name: string; host: string; } {
    const { backend, customBackendHost, customApiEndpoint } = settings.store;

    const predefined = PREDEFINED_SERVERS.find(s => s.id === backend);
    if (predefined) return { name: predefined.name, host: predefined.host };

    if (backend === "custom-simple") return { name: "Custom Server", host: customBackendHost || "not set" };
    return { name: "Custom Server", host: customApiEndpoint || "not set" };
}

function CustomServerForm({ onDone }: { onDone(): void; }) {
    const [type, setType] = useState<"simple" | "advanced">(settings.store.backend === "custom-advanced" ? "advanced" : "simple");
    const [host, setHost] = useState(settings.store.customBackendHost);
    const [apiEndpoint, setApiEndpoint] = useState(settings.store.customApiEndpoint);
    const [cdnHost, setCdnHost] = useState(settings.store.customCdnHost);
    const [gatewayEndpoint, setGatewayEndpoint] = useState(settings.store.customGatewayEndpoint);
    const [mediaProxyEndpoint, setMediaProxyEndpoint] = useState(settings.store.customMediaProxyEndpoint);

    const canSave = type === "simple" ? host.trim() : apiEndpoint.trim() && cdnHost.trim() && gatewayEndpoint.trim() && mediaProxyEndpoint.trim();

    const save = () => {
        settings.store.customBackendHost = host.trim();
        settings.store.customApiEndpoint = apiEndpoint.trim();
        settings.store.customCdnHost = cdnHost.trim();
        settings.store.customGatewayEndpoint = gatewayEndpoint.trim();
        settings.store.customMediaProxyEndpoint = mediaProxyEndpoint.trim();
        settings.store.backend = type === "simple" ? "custom-simple" : "custom-advanced";
        onDone();
        confirmRestart();
    };

    return (
        <Card className={classes(Margins.top16, "vc-endpoint-form")}>
            <div className="vc-endpoint-type-toggle">
                <Button size={Button.Sizes.SMALL} look={type === "simple" ? Button.Looks.FILLED : Button.Looks.OUTLINED} onClick={() => setType("simple")}>Simplified</Button>
                <Button size={Button.Sizes.SMALL} look={type === "advanced" ? Button.Looks.FILLED : Button.Looks.OUTLINED} onClick={() => setType("advanced")}>Advanced</Button>
            </div>

            {type === "simple" ? (
                <>
                    <Paragraph className={Margins.top8}>Just the bare host, no scheme, no trailing slash (e.g. "rory.server.spacebar.chat"). Assumes the instance follows the standard api./cdn./gateway. convention.</Paragraph>
                    <TextInput value={host} placeholder="rory.server.spacebar.chat" onChange={setHost} />
                </>
            ) : (
                <>
                    <Paragraph className={Margins.top8}>Each endpoint separately, for instances that don't follow the standard convention. Values come from https://&lt;host&gt;/api/policies/instance/domains.</Paragraph>
                    <TextInput className={Margins.top8} value={apiEndpoint} placeholder="API endpoint" onChange={setApiEndpoint} />
                    <TextInput className={Margins.top8} value={cdnHost} placeholder="CDN host" onChange={setCdnHost} />
                    <TextInput className={Margins.top8} value={gatewayEndpoint} placeholder="Gateway endpoint" onChange={setGatewayEndpoint} />
                    <TextInput className={Margins.top8} value={mediaProxyEndpoint} placeholder="Media proxy endpoint" onChange={setMediaProxyEndpoint} />
                </>
            )}

            <div className={classes(Margins.top16, "vc-endpoint-form-actions")}>
                <Button size={Button.Sizes.SMALL} disabled={!canSave} onClick={save}>Save Server</Button>
                <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={onDone}>Cancel</Button>
            </div>
        </Card>
    );
}

function EndpointTab() {
    settings.use(SETTING_KEYS);
    const [addingCustom, setAddingCustom] = useState(false);

    const { backend, customBackendHost, customApiEndpoint } = settings.store;
    const active = activeServerLabel();
    const hasCustomServer = !!(customBackendHost || customApiEndpoint);
    const customIsActive = backend === "custom-simple" || backend === "custom-advanced";

    const selectServer = (id: string) => {
        if (settings.store.backend === id) return;
        settings.store.backend = id;
        confirmRestart();
    };

    const removeCustomServer = () => {
        settings.store.customBackendHost = "";
        settings.store.customApiEndpoint = "";
        settings.store.customCdnHost = "";
        settings.store.customGatewayEndpoint = "";
        settings.store.customMediaProxyEndpoint = "";
        if (customIsActive) {
            settings.store.backend = PREDEFINED_SERVERS[0].id;
            confirmRestart();
        }
    };

    return (
        <div>
            <Card className="vc-endpoint-status-card">
                <div className="vc-endpoint-status-left">
                    <WebsiteIcon height={20} width={20} />
                    <div>
                        <Paragraph weight="bold">Connected to {active.name}</Paragraph>
                        <Paragraph size="sm" className="vc-endpoint-muted">{active.host}</Paragraph>
                    </div>
                </div>
                <div className="vc-endpoint-status-right">
                    <DoubleCheckmarkIcon height={16} width={16} />
                    Connected
                </div>
            </Card>

            <HeadingPrimary className={Margins.top20}>Servers</HeadingPrimary>
            <Paragraph className={Margins.bottom8}>Pick a Spacebar backend to connect to. Changing this requires a restart.</Paragraph>

            <div className="vc-endpoint-server-list">
                {PREDEFINED_SERVERS.map(server => (
                    <Card
                        key={server.id}
                        className={classes("vc-endpoint-server-card", backend === server.id && "vc-endpoint-server-card-active")}
                        onClick={() => selectServer(server.id)}
                    >
                        <div>
                            <Paragraph weight="bold">{server.name}</Paragraph>
                            <Paragraph size="sm" className="vc-endpoint-muted">{server.host}</Paragraph>
                        </div>
                        {backend === server.id && <DoubleCheckmarkIcon height={16} width={16} />}
                    </Card>
                ))}

                {hasCustomServer && (
                    <Card
                        className={classes("vc-endpoint-server-card", customIsActive && "vc-endpoint-server-card-active")}
                        onClick={() => selectServer(customApiEndpoint ? "custom-advanced" : "custom-simple")}
                    >
                        <div>
                            <Paragraph weight="bold">Custom Server</Paragraph>
                            <Paragraph size="sm" className="vc-endpoint-muted">{customBackendHost || customApiEndpoint}</Paragraph>
                        </div>
                        {customIsActive && <DoubleCheckmarkIcon height={16} width={16} />}
                    </Card>
                )}
            </div>

            {addingCustom ? (
                <CustomServerForm onDone={() => setAddingCustom(false)} />
            ) : (
                <div className={classes(Margins.top16, "vc-endpoint-form-actions")}>
                    <Button size={Button.Sizes.SMALL} look={Button.Looks.OUTLINED} onClick={() => setAddingCustom(true)}>
                        <PlusIcon height={14} width={14} /> {hasCustomServer ? "Edit Custom Server" : "Add Custom Server"}
                    </Button>
                    {hasCustomServer && (
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} color={Button.Colors.RED} onClick={removeCustomServer}>
                            Remove Custom Server
                        </Button>
                    )}
                </div>
            )}

            <HeadingTertiary className={Margins.top20}>About</HeadingTertiary>
            <Paragraph size="sm" className="vc-endpoint-muted">Spacebar is the default instance. Use a custom server to connect to a different one instead.</Paragraph>
        </div>
    );
}

function ChangeEndpointTab() {
    return (
        <SettingsTab>
            <EndpointTab />
        </SettingsTab>
    );
}

export default wrapTab(ChangeEndpointTab, "ChangeEndpoint");
