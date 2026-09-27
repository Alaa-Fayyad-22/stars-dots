# Stars & Dots

A multiplayer 4-digit guessing game. One person picks a secret number, everyone else guesses from their own phone.

- ★ star = right digit in the right place
- ● dot = right digit in the wrong place

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
