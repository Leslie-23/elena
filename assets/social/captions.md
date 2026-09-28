# Elena launch posts

Images in this folder:

| File | Size | Use |
|---|---|---|
| `01-cover.png` … `09-try.png` | 1080 × 1350 (4:5) | Carousel for Instagram, LinkedIn and X |
| `10-cover-landscape.png` | 1600 × 900 (16:9) | Single-image post or first image on X; LinkedIn landscape |
| `elena-carousel-linkedin.pdf` | 9 pages, 4:5 | LinkedIn "document" carousel (upload as a document) |

Every number on the slides was measured in this project: thinking off 26.9s → 3.7s, first reply 13.8s → 0.4s, eval 7/18 → 17/18 (Claude Code 18/18), Claude handoff $0.46 → $0.01 API-equivalent, 24 tools. The eval is labelled as small and self-built on purpose; keep that if you edit the copy.

The copy credits Claude Code, since it wrote most of the code. Change the wording if you like, but keep it accurate.

---

## LinkedIn

**Images:** upload `elena-carousel-linkedin.pdf` as a document (best reach for carousels), or slides 01–09 as images.

> I built Elena, a local AI developer assistant that lives in my terminal.
>
> She runs on a 14B open model (qwen3:14b via Ollama) on my M1 Pro. No API bill, and my code stays on my machine unless I approve sending it somewhere.
>
> What I learned building her:
>
> → Speed is a systems problem. Turning "thinking" off by default took short answers from 26.9s to 3.7s, and warming Ollama's prompt cache at startup took the first reply from 13.8s to 0.4s. The warm-up only worked once it matched the real request exactly, down to one flag.
>
> → Measure before you tune. I wrote a small eval: 10 tasks, 18 automatic checks, including a decoy file, a planted prompt injection and three planted bugs. Elena started at 39%. The model wasn't dumb, it was careless: answering without looking, giving up after one search, saying "let me check…" and stopping. Fixing that behaviour took her to 94%. Claude Code scored 100% on the same set.
>
> → Guardrails belong in code, not in the prompt. Every command, server start and cloud handoff asks first, her own tools never touch a shell, and text in files is treated as data, never instructions.
>
> → Local and cloud work better together. Elena hands heavy work to Claude Code in the background, and Claude can call Elena over MCP for local, free, private work: my notes, project scans, dev servers. Trimming what each handoff loads cut a small task from $0.46 to $0.01.
>
> Built with Claude Code. Install is one line (macOS/Linux), and the code is on GitHub: github.com/Leslie-23/elena
>
> Next: a bigger eval on real repos, tests and CI, and smarter context management.
>
> #AI #DeveloperTools #LocalAI #OpenSource #LLM #MCP

---

## X (thread)

X shows up to 4 images per post, so the thread splits them.

**1/** — images: `10-cover-landscape.png`
> I built Elena: a local AI developer assistant that lives in my terminal.
>
> 14B open model on my Mac. Free, private, and she hands the heavy lifting to Claude Code. 🧵

**2/** — images: `03-terminal.png`, `04-speed.png`
> Making a 14B model feel fast on a laptop:
>
> • thinking off by default: 26.9s → 3.7s
> • prompt-cache warm-up at startup: first reply 13.8s → 0.4s
>
> The warm-up only worked once it matched the real request exactly, down to one flag.

**3/** — images: `05-eval.png`, `06-fixes.png`
> I measured instead of guessing. Small self-built eval, 18 checks: 39% → 94% (Claude Code: 100%).
>
> The model wasn't dumb, it was careless: answering without looking, giving up after one search, "let me check…" and stopping. Fixing behaviour did most of it.

**4/** — images: `07-safety.png`, `08-handoff.png`
> Guardrails live in code: every command and cloud handoff asks first, no shell in her own tools, file text is data, not instructions.
>
> And it's two-way: Elena sends heavy work to Claude Code; Claude calls Elena over MCP for local work.

**5/** — images: `09-try.png`
> Built with Claude Code. One-line install for macOS/Linux:
>
> github.com/Leslie-23/elena

---

## Instagram

**Images:** carousel of `01-cover.png` → `09-try.png` (all 4:5, no cropping).

> Meet Elena e: a local AI developer assistant that lives in my terminal.
>
> She runs on a 14B open model on my Mac: free, private, and she hands the heavy lifting to Claude Code.
>
> Swipe for what it took: first reply 13.8s → 0.4s, an eval score from 39% → 94% by fixing her behaviour, and guardrails written in code, not in the prompt.
>
> Built with Claude Code. Link: github.com/Leslie-23/elena
>
> #buildinpublic #developer #coding #ai #localai #opensource #terminal #softwareengineering #macos
