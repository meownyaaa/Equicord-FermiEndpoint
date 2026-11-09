/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

export const cl = classNameFactory("vc-hypesquad-");

export const HYPESQUAD_ONLINE = "/hypesquad/online";

// the 2019 art is still served from discord's static assets
const asset = (hash: string) => `https://discord.com/assets/${hash}.svg`;

export type House = 1 | 2 | 3;

export const HOUSES: Record<House, { name: string; flag: number; logo: string; description: string; quizBody: string; }> = {
    1: {
        name: "Bravery",
        flag: 1 << 6,
        logo: asset("a359371246d6353de6bc32715e092eba"),
        description: "The universe needs people to lead the charge with confident optimism and tenacity. Without the brave, the HypeSquad would descend into chaos.",
        quizBody: "The House of Bravery thanks you for joining our efforts to preserve the sanctity of the land and maintain the legacy of Renwil. Your bravery is comparable to that of a thousand gallant warriors and without your leadership and prowess, we would be much closer to descending into chaos."
    },
    2: {
        name: "Brilliance",
        flag: 1 << 7,
        logo: asset("8c59bddd746488fe8acf23d8d36c1a60"),
        description: "It takes patience and discipline to become a vital member of the universe. Without brilliance, the HypeSquad would descend into chaos.",
        quizBody: "The House of Brilliance thanks you for joining our efforts to protect the land and maintain the legacy of Urdim. Your execution of strategies is that of a master tactician and without your calculated approach to any conflicts that comes your way, we would be much closer to descending into chaos."
    },
    3: {
        name: "Balance",
        flag: 1 << 8,
        logo: asset("07ed671b6c823a6cae5be39860ac8bf0"),
        description: "Harmony and poise are necessary to create equilibrium in the universe. Without balance, the HypeSquad would descend into chaos.",
        quizBody: "The House of Balance thanks you for joining our efforts to protect the land and maintain the legacy of Arame. Your ability to stay stout and steadfast in times of uncertainty is admirable. Without your natural understanding of both your environment and your inner self, we would be much closer to descending into chaos."
    }
};

export const houseOf = (flags: number) => ([1, 2, 3] as const).find(house => flags & HOUSES[house].flag) ?? null;

export const PATTERN = asset("c48ff253859d29a8825ddb00b59a4565");

export const PERKS = [
    {
        icon: asset("c970061def69b8226617841ca3089219"),
        title: "Super Secret Newsletter",
        description: "We regularly send out newsletters with contests, giveaways, and more."
    },
    {
        icon: asset("46b24114f7276738329be3ae84e22da4"),
        title: "Hype Profile Badge",
        description: "Get a unique profile badge to rep the HypeSquad House you're sorted into."
    },
    {
        icon: asset("b13ade832d7f19e30c5d2452b6cbdd53"),
        title: "Squad Challenges",
        description: "Rep your house and participate in challenges against other HypeSquad houses."
    }
];

export const QUESTIONS: [prompt: string, answers: [string, string, string, string]][] = [
    ["Wumpus appears at the front door, you:", ["Yell “LEROY JENKINS” and run directly at Wumpus", "Are baffled because Wumpus is a fictitious character and you’re on vacation", "Invite Wumpus into your home and offer him an icy cold beverage", "Faint, because you’re not very good with surprises"]],
    ["Nelly wants to play games with you on Discord, but you’d rather hang out with Wumpus, you:", ["Ditch the both of them and go eat birthday cake ice cream", "Turn your online status to “Invisible” and play with Wumpus", "Ask Nelly to play games with Clyde", "Nelly won’t mind, because Nelly is a robot"]],
    ["Wumpus wants to order a pineapple pizza, but you’re just not feeling it, you:", ["Order two pineapple pizzas because pineapples on pizza is :fire:", "Tell Wumpus that pineapple pizza is not okay", "Compromise and get ½ pineapple and ½ cheese", "Eat birthday cake ice cream instead"]],
    ["You’re planning a vacation with Wumpus, but you seem to disagree on travel locations, you:", ["Spin a globe and randomly choose a location", "Decide that you both enjoy spaghetti and go to Italy", "Stay at home and save up money to buy Discord Nitro", "You can’t agree on a location so you go on vacation by yourself"]],
    ["Nelly is planning on building a sequel to the popular SNEK game, but is unsure of what genre it should be, you:", ["Build a survival-horror game with Snek stranded in the woods", "Convince her it should be a puzzle game", "Say we need more platforming games!", "Tell Nelly it should be the next big Battle Royale game"]],
    ["Wumpus tells you to listen to his hot new mixtape, you:", ["Decide to make a music video and put it on YouTube and get millions of views", "Listen and analyze the mixtape in a dark secluded room", "Write a 10 page paper analyzing the deeper meanings for the lyrics", "Throw it on the ground"]],
    ["What do you usually follow?", ["Your gut", "Discord on Twitter", "Your heart", "I don’t understand this question"]],
    ["Which superhero power would you rather have?", ["Sick karate skills", "Superhuman reading speed", "Perfect aim", "Supersleep"]],
    ["You start watching a lot of Aggretsuko, but Wumpus wants to watch We Bare Bears, you:", ["Start singing death metal in hopes to change Wumpus’s mind.", "Watch We Bare Bears because that’s clearly the more superior show", "Compromise and watch Adventure Time", "Eat mint chip ice cream instead"]],
    ["Your team just wiped in a dungeon because Wumpus aggroed the boss too early, you:", ["Coach Wumpus on what they might be doing wrong", "Say nothing and resurrect the team", "Laugh it off and suggest trying again", "Kick Wumpus from the party and get Clyde as the new tank"]],
    ["Wumpus wants to go investigate a spoopy abandoned house in the middle of the night! Do you:", ["Grab your flashlight and charge in head-first", "Stand guard outside the spoopy house and yell at Wumpus if monsters arrive", "Cautiously stick with Wumpus, defending them from anything EXTRA-spoopy", "Absolutely refuse - there might be some huge spiders!"]],
    ["A new band is forming, and Wumpus is the lead guitarist! Problem is… he’s not very good. You go ahead and:", ["Leave the band to start your solo EDM career", "Teach him the four essential chords to any pop track", "Join the band anyways, you bet he’ll improve over time.", "Suggest that Wumpus probably pick up the tambourine instead"]],
    ["You're ascended to the peak of the highest mountain and the only thing separating you from riches is the three-headed dragon of the spire that stands in your way. You:", ["Charge into combat", "Watch old Godzilla movies to learn from his fights against King Ghidorah", "Try and convince the dragon to split the riches", "Offer the dragon a Wumpus plushie, how could it not want one?"]],
    ["What’s that sound?:", ["A lurking sword-wielding skeleton", "My massive collection of Newton’s Cradles", "The soft humming of your daily meditation", "Wumpus repeatedly @everyone pinging his server"]],
    ["The correct order of cereal is:", ["Bowl, spoon, milk, cereal", "Bowl, cereal, milk, spoon", "Bowl, milk, cereal, spoon", "Cereal, milk, spoon, bowl"]]
];
