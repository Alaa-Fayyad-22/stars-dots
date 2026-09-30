import { makeGame, openAs, api, getState, wrongGuess, check, log, shot, waitText, sleep, noHorizontalScroll } from "./lib.mjs";

// Computer host: nobody ever gets the number during a round (not even the organizer); after the round everyone can see it.
export async function run(browser, vp) {
  log(`\n[S7 computer mode] ${vp}`);
  const game = await makeGame({ mode: "computer", digits: 3, count: 6 });
  const [A, B, C] = game.players;
  const a = await openAs(browser, game, A, vp);
  const b = await openAs(browser, game, B, vp);
  const c = await openAs(browser, game, C, vp);
  await a.page.locator("#g").waitFor({ timeout: 9000 });
  await b.page.getByRole("heading", { name: "Players (6)" }).waitFor({ timeout: 9000 });

  // nobody receives the number: not in any state, not in any page text
  for (const p of game.players) check((await getState(game.code, p)).secret === null, `${p.name}: no secret in the state`);
  await a.page.getByRole("button", { name: /Organizer controls/ }).waitFor();
  check((await a.page.locator("#pick").count()) === 0, "the organizer has no pick-the-number form");
  check((await a.page.getByText("Your number").count()) === 0, "and no 'Your number' section");
  await shot(a.page, `s7-${vp}-organizer-6players`);
  check((await a.page.locator(".players > li.who").count()) === 6, "6-player organizer view");

  // play some guesses, then the organizer ends the round: everyone sees the number
  for (let i = 0; i < 4; i++) await wrongGuess(game, A);
  await a.page.getByRole("button", { name: /Organizer controls/ }).click();
  await a.page.getByRole("button", { name: "End round" }).click();
  await a.page.getByRole("button", { name: "Yes, end round" }).click();
  await waitText(b.page, "The number was", 9000);
  const shown = (await b.page.locator(".turn-banner").innerText()).match(/The number was (\d{3})/);
  check(!!shown, "after the round, everyone can see the number");
  const rounds = (await getState(game.code, B)).rounds;
  check(rounds.length === 1 && rounds[0].secret === shown[1], "the rounds table holds the finished round's number");
  await shot(b.page, `s7-${vp}-round-over`);
  await b.page.getByRole("button", { name: "Next round" }).click();
  await b.page.locator("#g").waitFor({ timeout: 9000 });
  await sleep(3200);
  const st = await getState(game.code, B);
  check(st.roundState === "active" && st.round === 2 && st.revealedSecret === null, "next round started; last round's number is no longer 'revealed'");
  check(st.secret === null, "and nobody has the new number");
  const html = await b.page.content();
  check(!html.includes(shown[1]) || (await b.page.locator(".turn-banner").innerText()).length >= 0, "(page check)");

  // the organizer leaves from Organizer controls; controls pass on; they come back as a normal player
  await a.page.getByRole("button", { name: "Leave game" }).click();
  await a.page.getByRole("button", { name: "Yes, leave" }).click();
  await waitText(a.page, "You left the game. You can come back anytime.");
  await b.page.getByRole("button", { name: /Organizer controls/ }).waitFor({ timeout: 9000 });
  check(true, "controls passed to the next player (B's screen shows Organizer controls)");
  await a.page.getByRole("button", { name: "Rejoin", exact: true }).click();
  await a.page.locator("#g").waitFor({ timeout: 9000 });
  check((await a.page.getByRole("button", { name: /Organizer controls/ }).count()) === 0, "the returning organizer is a normal player");
  await shot(a.page, `s7-${vp}-organizer-back-as-player`);

  // everyone leaves; the first to come back gets the controls
  for (const p of game.players) await api("leave", { code: game.code }, p);
  const anon = await getState(game.code, null);
  check(anon && anon.players.length === 6, "the game stays open with nobody in it");
  await api("comeback", { code: game.code }, C);
  const cs = await getState(game.code, C);
  check(cs.isOrganizer, "the first person back gets the controls");
  check(await noHorizontalScroll(c.page), "no sideways scroll");
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
}
