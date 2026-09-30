import { makeGame, openAs, api, getState, pickAs, check, log, shot, waitText, sleep, noHorizontalScroll, nextGuess } from "./lib.mjs";

// Hosting rotates through everyone; each screen is right for its role.
export async function run(browser, vp) {
  log(`\n[S1 rotation] ${vp}`);
  const game = await makeGame({ mode: "rotating", digits: 4, count: 6 });
  const [A, B, C, D, E, F] = game.players;
  const byName = { Hosty: A, Ana: B, Boro: C, Cleo: D, Dax: E, Eli: F };
  const a = await openAs(browser, game, A, vp);
  const b = await openAs(browser, game, B, vp);
  const c = await openAs(browser, game, C, vp);

  const hostNameOf = async () => (await getState(game.code, A)).hostName;

  // ---- round 1: Hosty hosts
  await waitText(a.page, "It's your turn to host");
  check(await a.page.locator("#pick").isVisible(), "host sees the pick-the-number form");
  await waitText(b.page, "Waiting for Hosty to pick the number");
  check(!(await b.page.locator("#pick").count()), "a player doesn't see the pick form");
  await shot(a.page, `s1-${vp}-1-host-picks`);
  await a.page.fill("#pick", "4715");
  await a.page.getByRole("button", { name: "Start the round" }).click();
  await waitText(a.page, "You're hosting this round");
  check(await a.page.getByText("Your number").isVisible(), "host sees their number section");
  check((await a.page.locator(".draft-boxes").count()) === 0, "host has no player tools (draft) in round 1");
  await b.page.locator("#g").waitFor({ timeout: 9000 });
  check(await b.page.locator(".draft-boxes").first().isVisible(), "a player has the notes/draft tools");
  await shot(a.page, `s1-${vp}-2-host-view-6players`);
  const rows = await a.page.locator(".players > li.who").count();
  check(rows === 6, `6-player list on the host view (got ${rows})`);
  check(await a.page.locator(".who-name-text", { hasText: "(host, you)" }).count() === 1, "the host is tagged in the list");
  check(await noHorizontalScroll(a.page), "no sideways scroll on the host view");

  // B opens the scratch sheet, then the round ends → B becomes host: the sheet closes and the player tools go.
  await b.page.getByRole("button", { name: "Scratch sheet" }).first().click();
  await b.page.locator("dialog.sheet[open]").waitFor();
  await shot(b.page, `s1-${vp}-3-b-sheet-open`);
  const end = await api("endround", { code: game.code }, A);
  check(!end.error, "host ends the round");
  await b.page.locator("dialog.sheet[open]").waitFor({ state: "detached", timeout: 9000 }).catch(() => {});
  await waitText(b.page, "It's your turn to host", 9000);
  check(!(await b.page.locator("dialog.sheet[open]").count()), "B's scratch sheet closed when B became host");
  check((await b.page.locator(".draft-boxes").count()) === 0, "B's player tools disappeared");
  check((await hostNameOf()) === "Ana", "winner-less round: host rotates to the next in join order (Ana)");
  await waitText(a.page, "Waiting for Ana to pick the number");
  await shot(b.page, `s1-${vp}-4-b-is-host`);

  // ---- round 2: Ana hosts. Make the LAST player (Eli) win, and check Eli does NOT become host.
  await b.page.fill("#pick", "2986");
  await b.page.getByRole("button", { name: "Start the round" }).click();
  await waitText(b.page, "You're hosting this round");
  for (let i = 0; i < 20; i++) {
    const s = await getState(game.code, B);
    if (s.currentPlayerId === F.id) break;
    const cur = game.players.find((p) => p.id === s.currentPlayerId);
    const used = new Set(s.players.flatMap((p) => p.history.map((h) => h.guess)));
    used.add("2986");
    await api("guess", { code: game.code, guess: nextGuess(4, used) }, cur);
  }
  const win = await api("guess", { code: game.code, guess: "2986" }, F);
  check(win.won === true, "Eli wins round 2");
  check((await hostNameOf()) === "Boro", "Eli won but hosting goes to Boro (next in join order), not the winner");
  await waitText(c.page, "It's your turn to host", 9000);
  check(await c.page.locator("#pick").isVisible(), "Boro (page) sees the pick form");
  check(await c.page.getByText("Eli cracked it").first().isVisible(), "everyone can see who won");
  await shot(c.page, `s1-${vp}-5-c-host-after-win`);

  // ---- rounds 3..8: keep rotating (Boro, Cleo, Dax, Eli, Hosty, Ana) via the API
  const expected = ["Boro", "Cleo", "Dax", "Eli", "Hosty", "Ana", "Boro"];
  for (let r = 0; r < expected.length; r++) {
    const name = await hostNameOf();
    check(name === expected[r], `round ${r + 3}: host is ${expected[r]} (got ${name})`);
    await pickAs(game, byName[name], "1357");
    await api("endround", { code: game.code }, byName[name]);
  }

  // screens still fine on every page at the end
  for (const [n, p] of [["a", a], ["b", b], ["c", c]]) check(await noHorizontalScroll(p.page), `${n}: no sideways scroll`);
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
}
