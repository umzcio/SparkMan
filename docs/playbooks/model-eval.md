# Playbook: evaluate a model on the fleet

For an AI agent (or a person) asked to "benchmark model X" or "is build B as good as build A". It sets which
tests run when, how they are run, and how two results are compared, so that numbers from different weeks and
different models can be put side by side. Placeholders: `<head>` (the serving node), `<eval-host>` (where the
runners live; the SparkMan host), `<eval-user>` (the unprivileged account they run as).

## 0. Before anything

1. **An explicit go.** Tests and benchmarks run only when the operator asks for them. Say which tier, on which
   deployment, and roughly how long it will hold the hardware.
2. **Ground rules** are those of `model-install.md`: model APIs stay on the private networks; third-party test
   code runs as `<eval-user>`, never root; never print a secret.
3. **The deployment is settled.** Note what is being tested: model and revision, quantization, engine and build,
   number of nodes, streams and context. Results without this are not comparable.

## 1. Tiers

| Tier | When | What | Time |
|---|---|---|---|
| 0. Serving check | every new deployment | a plain reply, a tool call, the recipe's golden replies; SparkMan decode + prefill | < 30 min |
| 1. Quick quality | every new model or build | SparkMan's quality suite and tool-eval (quick); perplexity and KL against the full model for a quantization we made | 1–2 h |
| 2. Capability baseline | once per model, on its fastest setup | the fixed suite below | one night |
| 3. Deep | to answer a specific question | full CTF benchmarks, several agent harnesses, SWE-bench Verified | days |

Tiers 0 and 1 run from SparkMan's Benchmarks page. Tier 2 runs from the evals repo on `<eval-host>`.

## 2. The Tier 2 suite

Knowledge and reasoning (GPQA Diamond; a fixed 700-item subset of MMLU-Pro), math (AIME, 4 samples per
problem), instruction following (IFEval), coding (LiveBench coding), tool use (BFCL multi-turn and live
multiple), long context (rule-scored RULER-style tasks at 32K and 128K), agentic coding (Terminal-Bench 2), and
security (Cybench, 40 tasks × 3 attempts).

Rules that keep it comparable:

- **The same items for every model.** Subsets are chosen by a fixed seed; the suite has a version, and runs
  from different versions are not compared.
- **Scored by rule, never by a model.** A model grading answers (often the one under test) adds its own bias.
- **One sampling setting per model, recorded.** The model card's recommendation, else temperature 0.6 and
  top-p 0.95, with a 32K output cap.
- **Serve with enough streams** for the runner's concurrency, or requests queue and the run takes days.
- **Keep sandboxes bounded.** Agent tests start a container per task on `<eval-host>`; cap each one's memory
  and processes. One runaway challenge server once took 80 GB of the host.

## 3. Comparing two results

Compare item by item, never only the headline percentages:

1. Match items by id; average repeated samples within an item.
2. Report each side's mean, the difference with a 95% bootstrap interval that resamples whole items, and an
   exact sign test over items where the two differ.
3. Report output tokens per item next to the score. A model that writes twice as much for the same score
   costs twice the time on the same hardware. When the two ran at different speeds under a time limit (agent
   tests), also report an equal-work comparison: count a solve only within the time the slower model's token
   budget allows.
4. Call a difference real only when the interval excludes zero. A tie is a result; say so plainly.

## 4. Report

Per test: items, both scores, the difference and its interval, tokens per item, wall time. List what was
skipped or failed and why. Keep raw logs (prompts and replies) on `<eval-host>`; publish only per-item scores
and settings, with no hostnames or addresses.
