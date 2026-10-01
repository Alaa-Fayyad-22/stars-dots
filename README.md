# Stars & Dots

A multiplayer 4-digit guessing game. One person picks a secret number, everyone else guesses from their own phone.

- ★ star = right digit in the right place
- ● dot = right digit in the wrong place

## Modes

- **Rotating host** — hosting goes around in the order people joined; the host picks the number.
- **Computer host** — the game picks the number; everyone plays every round.
- **Duel** — 2 players. Each picks a secret number and cracks the other's; if the player who went first cracks it, the other gets one final turn (a draw if they crack it too). Who goes first alternates each round.

Every person gets a color (shown next to their name), every finished round has a replay (tap a row in the Rounds table), the host / organizer / either duelist can end the game for a "Game over" summary with awards, and the speaker button in the top bar controls the chat and "Your turn" sounds (saved on that device).

## Deploy on Vercel

1. Put this folder in a GitHub repository.
2. On vercel.com: **Add New → Project**, pick the repository, click **Deploy**.
3. In the project: **Storage → Create Database → Upstash (Redis)** → pick the free plan → connect it to the project.
   This adds the environment variables automatically.
4. Go to **Deployments** and **Redeploy** so the app picks up the database.

## Run locally

Create `.env.local` with your Upstash REST URL and token:

    UPSTASH_REDIS_REST_URL=...
    UPSTASH_REDIS_REST_TOKEN=...

Then run `npm install` and `npm run dev`.
