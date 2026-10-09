/**
 * Message corpus for load testing.
 * Mix of gaming shortcuts, trash talk, borderline, profane, and clearly unsafe.
 * Proportions roughly match what a real public chat looks like.
 */

export interface CorpusEntry {
  text: string;
  category: "shortcut" | "banter" | "borderline" | "profane_mild" | "profane_slur" | "threat";
}

export const CORPUS: CorpusEntry[] = [
  // --- shortcuts (should hit M3a2, zero AI cost, instant) ---
  { category: "shortcut", text: "gg" },
  { category: "shortcut", text: "wp" },
  { category: "shortcut", text: "ggwp" },
  { category: "shortcut", text: "nt" },
  { category: "shortcut", text: "gl" },
  { category: "shortcut", text: "glhf" },
  { category: "shortcut", text: "hello" },
  { category: "shortcut", text: "hi" },
  { category: "shortcut", text: "ty" },
  { category: "shortcut", text: "np" },
  { category: "shortcut", text: "lol" },
  { category: "shortcut", text: "nice shot" },
  { category: "shortcut", text: "well played" },
  { category: "shortcut", text: "brb" },
  { category: "shortcut", text: "afk" },

  // --- banter (should hit Clef, safe) ---
  { category: "banter", text: "that was clutch" },
  { category: "banter", text: "anyone wanna run it back" },
  { category: "banter", text: "ping is horrible today" },
  { category: "banter", text: "nice flank" },
  { category: "banter", text: "watch the left side" },
  { category: "banter", text: "they're pushing B" },
  { category: "banter", text: "need backup here" },
  { category: "banter", text: "lets dominate them" },
  { category: "banter", text: "we got absolutely rekt" },
  { category: "banter", text: "that aim was insane" },
  { category: "banter", text: "camping is lame" },
  { category: "banter", text: "the new map is actually fun" },
  { category: "banter", text: "squad up for ranked" },
  { category: "banter", text: "my internet died for a sec" },
  { category: "banter", text: "lets kill them next round" },
  { category: "banter", text: "destroy these noobs" },
  { category: "banter", text: "crush them this match" },
  { category: "banter", text: "frag city tonight boys" },
  { category: "banter", text: "that was a sick play" },
  { category: "banter", text: "ez game ez life" },

  // --- borderline (Clef should hedge; blocked at 0.3) ---
  { category: "borderline", text: "you aim like a bot" },
  { category: "borderline", text: "ur mom gay" },
  { category: "borderline", text: "your dad is a loser" },
  { category: "borderline", text: "what a trash team" },
  { category: "borderline", text: "pathetic performance" },
  { category: "borderline", text: "hardstuck gold forever" },
  { category: "borderline", text: "bot lobby confirmed" },
  { category: "borderline", text: "uninstall the game" },

  // --- mild profanity (should pass Clef as emphasis) ---
  { category: "profane_mild", text: "fucking campers i swear" },
  { category: "profane_mild", text: "that bitch of a boss killed me" },
  { category: "profane_mild", text: "holy shit nice shot" },
  { category: "profane_mild", text: "damn son thats clean" },
  { category: "profane_mild", text: "gg, next round we crush these mofos" },

  // --- clear profanity (should hit M3a wordlist, zero AI cost) ---
  { category: "profane_slur", text: "fuck off" },
  { category: "profane_slur", text: "piece of shit team" },
  { category: "profane_slur", text: "asshole stop camping" },
  { category: "profane_slur", text: "you are a dick" },

  // --- threats / self-harm (should hit Clef, strongly blocked) ---
  { category: "threat", text: "kys loser" },
  { category: "threat", text: "go kill yourself irl" },
  { category: "threat", text: "i will find your house" },
  { category: "threat", text: "i know where you live" },
];

/**
 * Realistic distribution: shortcuts are most common in real chat.
 * This weights the random pick to reflect real traffic shape.
 */
const WEIGHTS: Record<CorpusEntry["category"], number> = {
  shortcut: 35,       // 35% of messages
  banter: 40,         // 40%
  borderline: 10,     // 10%
  profane_mild: 8,    // 8%
  profane_slur: 5,    // 5%
  threat: 2,          // 2%
};

const WEIGHTED: CorpusEntry[] = (() => {
  const out: CorpusEntry[] = [];
  for (const entry of CORPUS) {
    const w = WEIGHTS[entry.category];
    for (let i = 0; i < w; i++) out.push(entry);
  }
  return out;
})();

export function pickRandomMessage(): CorpusEntry {
  return WEIGHTED[Math.floor(Math.random() * WEIGHTED.length)]!;
}

const TOXIC = CORPUS.filter(
  (e) => e.category === "profane_slur" || e.category === "threat",
);

/**
 * Pick a message guaranteed to be moderation-rejected. Used by --toxic bots in
 * the loadtest to exercise the discipline (strike/mute/ban) path.
 */
export function pickToxicMessage(): CorpusEntry {
  if (TOXIC.length === 0) return pickRandomMessage();
  return TOXIC[Math.floor(Math.random() * TOXIC.length)]!;
}
