# Which agent writes the words and the scenes

Two steps in this pipeline hand a prompt to a coding agent and let it write
files:

- **Draft a script** — Scripts → *Draft it* writes `<project>/scripts/<name>.md`.
- **Generate a composition** — Make a video → *Build the brief* → *Run it*, which
  writes the scene HTML the renderer then steps through frame by frame.

Both used to shell out to `claude` with the argv written inline at the call site,
twice, identically. That hardcoded two things which are really one decision:
which agent, and therefore whose account and whose bill.

The decision now lives in one place, [`lib/agents.mjs`](../lib/agents.mjs), and
the choice is stored beside the other settings in
`~/.config/rolemodel-openscreen/config.json`.

## The two agents

| | `claude` | `pi` |
|---|---|---|
| What it is | Claude Code | [Pi](https://pi.dev), a model-agnostic agent harness |
| Bill lands on | your Claude Code subscription | whichever provider Pi is configured for |
| Non-interactive | `-p <prompt>` | `-p <prompt>` |
| Write files without asking | `--permission-mode acceptEdits` | `--approve` |
| Streamed events | `--output-format stream-json --verbose` | `--mode json` |
| Model chosen by | the subscription | Pi's own config (`--provider`, `--model`) |
| **Run here?** | **yes, this is the default** | **no — see below** |

## Pi is wired up and has not been run

This is the part to read before switching.

The flags above come from Pi's CLI reference, not from a run against a real
install. Nothing in this repo has produced a script or a scene through Pi. It is
wired so that trying it is a config change rather than a patch, and it is left
switched off so that nobody discovers it by having a render fail.

`AGENTS.pi.ready` is `false` for exactly that reason. It should flip to `true`
when someone has run **both** steps end to end and a scene generated that way has
actually rendered — not when the command merely exits zero.

### What Pi does not change

Pi is not an inference provider. It routes to fifteen or so of them, so it does
not make anything cheaper by itself: **it makes it cheaper only if you point it
at a cheaper model than Claude.** Pointed at Anthropic it is the same tokens at
API prices, which is likely *more* expensive than a Claude Code subscription, not
less.

So the real question is not Pi versus Claude. It is which model is good enough
for these two jobs, and they are not equally forgiving:

- **Drafting a script** is prose. A cheaper model is very likely fine.
- **Generating a composition** writes HTML against the component set in
  `components/rm-video.js`, with timing attributes the renderer depends on. A
  model that gets this subtly wrong costs more in debugging than it saves in
  tokens, and the failure is not always obvious — a scene that renders but holds
  the wrong beat looks like a design problem.

The sensible first experiment is the script step, not the scene step.

## Open questions for whoever picks this up

1. **Does `--approve` mean what `acceptEdits` means?** Pi's docs describe it as
   trusting project-local files for a single run. Claude's `acceptEdits` permits
   edits without prompting. If Pi's trust is narrower, the scene step will stall
   waiting for an answer nobody can give it — the job runner has no stdin.

2. **What shape are Pi's JSON events?** The Console renders Claude's
   `stream-json` shape in `claudeLine()`. Pi's `--mode json` emits its own. There
   is no Pi renderer, and deliberately so: unrecognised JSON already falls
   through and is printed raw rather than dropped, so a Pi run will be *legible
   but ugly* rather than an empty Console. Writing `piLine()` is the polish, and
   it should happen only after someone has seen real output to write it against.

3. **Does Pi honour `cwd`?** Both steps run from the directory the prompt writes
   into, and relative paths in the prompt depend on it.

4. **Which provider and model?** Deliberately not set in `agents.mjs`. Pi
   resolves its own configured default, so the choice — which is the entire cost
   question — stays with whoever set Pi up rather than being frozen into this
   repo by someone who cannot see their account.

## Turning it on

```sh
# what is available, and what is chosen
curl -s localhost:<port>/api/agent

# choose one
curl -s -X POST localhost:<port>/api/agent \
  -H 'content-type: application/json' -d '{"agent":"pi"}'
```

The port changes each launch — the Studio prints it, and the app hosts it on a
free port it picks at start.

`pi` must also be on `PATH`, and it is allowlisted in
[`lib/jobs.mjs`](../lib/jobs.mjs). That allowlist is the thing standing between a
prompt and an arbitrary process, so an agent missing from it cannot be started
however the setting is configured — which is intentional, and is why adding an
agent is two edits rather than one.

## Where the editor's chat fits

Separate system, worth not confusing with this.

The editor window (the fork's AI edition) has its own provider registry and keeps
credentials in the OS keychain through Electron's `safeStorage`, so a key set
there is already permanent. That registry talks to **APIs** — Anthropic, OpenAI,
Gemini, Mistral, OpenRouter, MiniMax, or anything OpenAI-compatible via a base
URL — and not to a Claude subscription. The fork removed subscription-reaching
flows in 1.8.0 because reaching one meant shipping a vendor's own OAuth client id
inside a signed installer.

So the two halves bill differently by default: **Studio steps run on a
subscription, the editor chat runs on a metered API key.** Pi changes the first
of those, not the second.
