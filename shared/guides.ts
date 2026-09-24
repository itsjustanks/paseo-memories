/**
 * The Guide tab in plain mode: short how-tos, each three to six steps, naming
 * the real buttons. Pure text; the jargon test reads every line.
 */

export type PlainGuide = { title: string; steps: string[] };

export const PLAIN_GUIDES: PlainGuide[] = [
  {
    title: "What your agents remember, and where it comes from",
    steps: [
      "Open the Overview tab. Under \"What your agents remember\" you can see each agent and roughly how many words it reads when it starts.",
      "Your own instructions go with you into every project. You'll find them under Everywhere.",
      "Each project can add its own. Open Projects and pick one: \"Claude's notes\" for a project are private to you, while everyone who works on the project sees its \"Project instructions\".",
      "\"Instructions for every agent on this computer\" apply to everyone who uses this Paseo computer.",
      "In a workspace, open the Memories panel to see what an agent started there reads, in order.",
    ],
  },
  {
    title: "Add something every agent should know",
    steps: [
      "On the Overview, press Add a note.",
      "Write what your agents should remember, in plain sentences. One idea per note works best.",
      "Choose who should follow it (All my agents, Just Claude or Just Codex) and where (Everywhere, or only one project).",
      "Press Check it. You'll see exactly where the note goes, and whether a note that says almost the same is already there.",
      "Press Save. New agents follow it straight away; agents already running won't see it until they restart.",
    ],
  },
  {
    title: "Fix a note an agent keeps getting wrong",
    steps: [
      "Type a word from the note into \"Find a note\" on the Overview, or open Everywhere or Projects and pick where it lives.",
      "Find the note and press Change. Fix the title or the text, then press Save.",
      "If the note is wrong altogether, press Remove and confirm.",
      "Say it plainly and positively: \"Invoices go out on the 1st\" works better than \"Don't forget about invoices\".",
      "Start a new agent to try it. Agents that are already running keep what they read when they started.",
    ],
  },
  {
    title: "Keep passwords and keys out of notes",
    steps: [
      "Every agent that reads a note can see everything in it, including passwords and keys.",
      "When a note holds something that looks like one, the Overview lists it under \"Worth a look\". Press Show me.",
      "Press Show to see the hidden part, press Change to take it out of the note, then press Save.",
      "Keep the real password in your password manager, and write in the note where to find it instead.",
    ],
  },
  {
    title: "Move your notes to another Paseo computer",
    steps: [
      "On this computer, open Import & Export. Under Export, choose Everything (or one project) and \"To bring into another computer\".",
      "Press Export, then Download (or Copy).",
      "On the other computer, open Import & Export. Paste the text, or press \"Pick files…\" and choose what you downloaded.",
      "Press Read it, choose where the notes go, then press Check it.",
      "Tick the notes you want and press Save. Passwords and keys stay hidden unless you chose to include them.",
    ],
  },
  {
    title: "What you can't change here, and why",
    steps: [
      "Instructions your organisation sets: they come from your IT or admin team.",
      "Codex's working notes: Codex rebuilds them itself, so a change would be lost. \"What Codex has learned\" can be changed, but Codex rewrites it in its own words the next time it runs.",
      "Instructions kept in an agent's settings file, and Copilot's notes, which GitHub keeps online.",
      "Anything marked \"Can't be changed here\" says why when you open it.",
    ],
  },
];

export const PLAIN_GUIDE_TECHNICAL_HINT = "The numbers, the files and the order each agent reads them in. Turn on \"Show technical details\" in Settings → Memories to see file names and edit whole files.";
