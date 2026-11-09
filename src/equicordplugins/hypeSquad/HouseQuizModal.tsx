/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, RestAPI, useState } from "@webpack/common";
import type { ComponentType } from "react";

import { cl, House, HOUSES, HYPESQUAD_ONLINE, QUESTIONS } from "./houses";

type RadioGroup = ComponentType<{ options: { name: string; value: string; }[]; value: string | undefined; onChange(value: string): void; }>;

let ManaBaseRadioGroup: RadioGroup;

export function setManaBaseRadioGroup(component: RadioGroup) {
    ManaBaseRadioGroup = component;
}

const QUESTION_COUNT = 5;
const ANSWER_HOUSES = ["1", "2", "3", "random"];

const randomHouse = () => (Math.floor(Math.random() * 3) + 1) as House;

function pickQuestions() {
    const picked: number[] = [];
    while (picked.length < QUESTION_COUNT) {
        const index = Math.floor(Math.random() * QUESTIONS.length);
        if (!picked.includes(index)) picked.push(index);
    }
    return picked.map(index => QUESTIONS[index]);
}

// the most picked house wins, ties go to whichever reached the top count first like 2019 did
function tallyHouse(responses: string[]): House {
    const counts: Record<string, number> = {};
    let best: string | undefined;
    for (const response of responses) {
        counts[response] = (counts[response] ?? 0) + 1;
        if (best === undefined || counts[response] > counts[best]) best = response;
    }
    return best === undefined || best === "random" ? randomHouse() : Number(best) as House;
}

export function HouseQuizModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [questions] = useState(pickQuestions);
    const [step, setStep] = useState(0);
    const [responses, setResponses] = useState<string[]>([]);
    const [house, setHouse] = useState<House | null>(null);
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);

    const lastQuestion = step === questions.length - 1;
    const answered = responses[step] != null;

    const submit = async () => {
        const picked = tallyHouse(responses);
        setPending(true);
        try {
            await RestAPI.post({ url: HYPESQUAD_ONLINE, body: { house_id: picked } });
            setHouse(picked);
            setFailed(false);
        } catch {
            setFailed(true);
        }
        setPending(false);
    };

    if (failed) {
        return (
            <Modal
                {...modalProps}
                size="md"
                title="Something went wrong!"
                actions={[
                    { text: "Retry", variant: "primary", onClick: submit, loading: pending },
                    { text: "Cancel", variant: "secondary", onClick: modalProps.onClose }
                ]}
            >
                <div className={cl("quiz-content")}>
                    <BaseText className={cl("quiz-heading")} size="lg" weight="semibold">Uh oh, we broke Discord!</BaseText>
                    <BaseText>There was an error adding you to HypeSquad Online. If the error persists, ask your instance owner.</BaseText>
                </div>
            </Modal>
        );
    }

    if (house) {
        const { name, logo, quizBody } = HOUSES[house];
        return (
            <Modal
                {...modalProps}
                size="sm"
                title="You've been picked!"
                actions={[{ text: "Close", variant: "primary", onClick: modalProps.onClose }]}
            >
                <div className={cl("quiz-content")}>
                    <div className={classes(cl("quiz-logo-wrapper"), cl(`house-${house}`))}>
                        <img className={cl("quiz-logo")} src={logo} alt={`House of ${name}`} />
                    </div>
                    <BaseText className={cl("quiz-heading")} size="lg" weight="semibold">House of {name}</BaseText>
                    <BaseText className={cl("quiz-body")}>{quizBody}</BaseText>
                </div>
            </Modal>
        );
    }

    const [prompt, answers] = questions[step];

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`Question ${step + 1} of ${questions.length}`}
            actions={[
                lastQuestion
                    ? { text: "Show me my house!", variant: "primary", onClick: submit, disabled: !answered, loading: pending }
                    : { text: "Next question", variant: "primary", onClick: () => setStep(step + 1), disabled: !answered },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose }
            ]}
        >
            <div className={cl("quiz-content")}>
                <BaseText size="md" weight="semibold">{prompt}</BaseText>
                <hr className={cl("quiz-separator")} />
                <BaseText className={cl("quiz-select")} size="sm">Select your answer:</BaseText>
                <ManaBaseRadioGroup
                    key={step}
                    options={answers.map((answer, i) => ({ name: answer, value: ANSWER_HOUSES[i] }))}
                    value={responses[step]}
                    onChange={value => setResponses(prev => Object.assign([...prev], { [step]: value }))}
                />
            </div>
        </Modal>
    );
}
