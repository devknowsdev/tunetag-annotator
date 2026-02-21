# BeatPulse Annotator — Claude Code Session Briefing
*Paste this as your very first message. Then paste prompts from CLAUDE_CODE_SESSION.md one at a time.*

---

You are working on the BeatPulse Annotator project. Before we begin, read this briefing in full.

## Project location
```
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator
```

## Your working doc
The file CLAUDE_CODE_SESSION.md contains all the prompts for this session in order. Do not read ahead or combine prompts — I will paste them one at a time. Wait for my paste before doing anything.

## Rules for this session

**1. One prompt at a time.**
Do not start the next prompt until I paste it. Do not combine steps from multiple prompts into one action.

**2. TypeScript check after every prompt.**
Run `npx tsc --noEmit` at the end of every prompt and report the result. Do not proceed if there are errors — report them and wait.

**3. Surgical edits only.**
When editing existing files, change only what the prompt says to change. Do not refactor, rename, reformat, or reorganise anything that isn't explicitly mentioned.

**4. Never touch completed work.**
CLAUDE_CODE_SESSION.md has an "ALREADY DONE" section at the top listing everything built in previous sessions. Do not modify any of those files unless a prompt explicitly instructs it.

**5. Report clearly after each prompt.**
When done, confirm:
- What files were created or modified
- TypeScript result (clean ✓ or errors listed)
- Line count if the prompt asks for it

**6. If you hit an error you can't resolve in 2 attempts, stop and report it.**
Don't spiral. Describe what you tried and what the error was. I'll help fix it before we continue.

**7. Compute efficiency.**
Phases are prioritised in the doc. If you sense we're running low on context, flag it before starting the next prompt so I can decide whether to continue or stop and commit.

## Before the first prompt — confirm you're ready

Run the following and report back:
```bash
cd "/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator"
npx tsc --noEmit
git log --oneline -5
wc -l src/components/PhaseListening.tsx
```

Once I see a clean TypeScript result and the git log, I'll paste the first prompt.
