# yesand

A private one-page site: one password, then a long scroll of text, images and audio.

There is no server behind it and no database — just a folder of static files on GitHub Pages.
All of the content is encrypted before it is committed, so the public repo holds nothing
readable. And no password is stored anywhere to compare against: the one you type *is* the
decryption key, so a wrong one doesn't get rejected by a check, it simply produces nothing. The
flip side of having no server is that there is nothing to rate-limit either — the encrypted files
are public, so the passphrase is the whole of the security. Mechanics in the next section.

Vibe coded with [Claude Code](https://claude.com/claude-code) inside a
[Docker sandbox](https://docs.docker.com/ai/sandboxes/).

## How the gate works

`crypto.js` derives an AES-256-GCM key from the passphrase with PBKDF2 (600k iterations,
SHA-256) and a random salt. GCM's authentication tag makes "is this the right passphrase" and
"decrypt the content" a single operation — a wrong passphrase throws and no plaintext is ever
produced. There is no stored hash and no comparison logic anywhere in this repo.

One derived key protects two published things:

| File | Contents |
|---|---|
| `content.enc.js` | the texts — `{salt, blob}`, a few KB, loaded eagerly by the gate |
| `media/<id>.enc` | one encrypted blob per photo / voice note / clip, fetched and decrypted lazily as it scrolls into view |

Everything else in the repo (HTML, CSS, JS) is plain source and is meant to be. Security rests
on the passphrase, not on hiding the code.

## The one rule

**`content/` is gitignored and must stay that way.** It holds the only unencrypted copy of the
text and media. Committing it would publish exactly what the encryption exists to protect, and
git keeps anything committed even once.

Because it is untracked, **git is not a backup of it** — keep your own copy of `content/`
somewhere outside the repo. `build-content.js` refuses to run if `content/` becomes tracked, as
a backstop.

## Requirements

- Node 18+
- `ffmpeg` + `ffprobe` — `brew install ffmpeg` / `apt install ffmpeg`
- `heif-convert` for iPhone `.HEIC` photos — `brew install libheif` / `apt install libheif-examples`

These are build-time tools only: nothing here ships to the browser, and the published site has no
dependencies whatsoever. The build has only been exercised inside the Docker sandbox above, where
they were installed with `apt` — the `brew` equivalents are for running it directly on macOS.

## Build and run

```
node build-content.js          # rebuild the payload; prompts for the passphrase
node build-content.js --scan   # list files in content/inbox/ not referenced by content.json yet
python3 -m http.server 8080    # then open http://localhost:8080
```

Run the build after every edit to `content/content.json` or anything in `content/inbox/`.
Unchanged media are left alone, and the payload itself is only rewritten when the text actually
changed — so a build that changes nothing leaves every file untouched and `git status` stays
clean. There is a third command, `--rotate-password`, covered under Passphrase below.

Where content files go, and how to write links and multi-paragraph text in `content.json`, are
explained in the comment block at the top of `build-content.js` and beside `setProse` and
`flattenProse` in the source.

## Passphrase

The build prompts for it; nothing is stored and nothing lands in your shell history. Keep it in a
password manager. `SITE_PASSWORD` is honoured for scripted builds but is not the normal path —
putting it on a command line writes it into your shell history.

Pick a passphrase, not a word. The ciphertext is public, so it can be attacked offline at roughly
10,000 guesses/second on a good GPU. Four lowercase words with dashes is both phone-typable and
far beyond what this needs.

### When to use `--rotate-password`

A normal build reuses the salt already in `content.enc.js` and checks what you typed against it.
That check is what makes a typo an error instead of a silent disaster — mistype it and the build
aborts having changed nothing, so you just run it again.

`--rotate-password` skips that check and deliberately re-keys everything: new salt, new key,
`content.enc.js` and **all** of `media/*.enc` rewritten. Use it only to change the passphrase.

| Situation | What to run |
|---|---|
| Edited a text, added a photo | `node build-content.js` with the same passphrase |
| It said the passphrase doesn't match | Nothing broke — run again and type it correctly |
| Switching a throwaway dev passphrase to the real one | `node build-content.js --rotate-password` |
| Forgot the passphrase, nothing published yet | `node build-content.js --rotate-password` — it doesn't need the old one |
| The passphrase leaked after launch | `--rotate-password`, but see the warning below |

A rotation has no existing payload to check a typo against, so it asks for the new passphrase
twice. Load the page and type it once afterwards anyway.

**Rotation does not retroactively protect anything already pushed.** The old ciphertext stays in
git history and the old passphrase still opens it. If the passphrase leaks after the repo is
public, rotating protects future content only — recovering properly means a fresh repo.

## Deployment

Live at **https://grbtm.github.io/yesand/**. GitHub Pages serves this repo as flat static files:
no build step, no backend. `.nojekyll` stops Pages running a Jekyll build over them; `robots.txt`
plus a `noindex` meta keep it out of search results.

No custom domain, deliberately: `github.io` is on the browsers' HSTS preload list, so the site
can never be reached over plain HTTP. That matters more than usual here — an attacker who could
swap `main.js` in transit would get the passphrase — and a Pages custom domain cannot send HSTS
headers. For the same reason, anyone who can push to this repo can replace `main.js`, so keep 2FA
on the account and don't add collaborators.

### Before pushing

- [x] Passphrase is the real one, and you have loaded the page and typed it successfully. Git
      keeps every commit forever, so anything pushed under a weak passphrase stays recoverable
      with that passphrase even after you rotate.
- [x] `node build-content.js` has been run since the last content edit, and running it again
      now leaves `git status` clean — that is what proves the committed payload matches
      `content/content.json`.
- [x] `git status --ignored` lists `content/` and `.cache/` as ignored, and
      `git diff --cached --name-only` shows nothing under `content/`.
