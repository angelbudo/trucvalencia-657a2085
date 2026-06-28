import { describe, expect, it } from "vitest";
import { createMatch } from "./engine";
import type { Card } from "./types";
import {
  partnerAnswerFor,
  shouldIssueProactiveEnvitOrder,
  shouldProactivelyOrderEnvit,
} from "./botConsult";

const c = (rank: Card["rank"], suit: Card["suit"]): Card => ({
  rank,
  suit,
  id: `${rank}-${suit}`,
});

describe("envit bot rules", () => {
  it("orders Envida! with 31+ when asked about envit", () => {
    const match = createMatch();
    match.round.hands[1] = [c(7, "oros"), c(4, "oros"), c(5, "copes")];

    expect(shouldProactivelyOrderEnvit(31)).toBe(true);
    expect(partnerAnswerFor(match, 1, "tens-envit", 0)).toBe("envida");
    expect(partnerAnswerFor(match, 1, "vols-envide", 0)).toBe("envida");
  });

  it("does not let a 33 envit stay silent or become an ambiguous yes", () => {
    const match = createMatch();
    match.round.hands[3] = [c(7, "espases"), c(6, "espases"), c(4, "bastos")];

    expect(shouldProactivelyOrderEnvit(33)).toBe(true);
    expect(partnerAnswerFor(match, 3, "tens-envit", 1)).toBe("envida");
    expect(partnerAnswerFor(match, 3, "vols-envide", 1)).toBe("envida");
  });

  it("only lets the first bot of the pair order envida to the second player of the pair", () => {
    expect(
      shouldIssueProactiveEnvitOrder(31, {
        trickIndex: 0,
        actor: 2,
        speaker: 0,
        mano: 0,
        envitAlreadyCalled: false,
      }),
    ).toBe(true);

    expect(
      shouldIssueProactiveEnvitOrder(31, {
        trickIndex: 0,
        actor: 0,
        speaker: 2,
        mano: 0,
        envitAlreadyCalled: false,
      }),
    ).toBe(false);
  });

  it("allows a 30 envit proactive order only when partner is fourth to act", () => {
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    expect(
      shouldIssueProactiveEnvitOrder(30, {
        trickIndex: 0,
        actor: 3,
        speaker: 1,
        mano: 0,
        envitAlreadyCalled: false,
      }),
    ).toBe(true);

    expect(
      shouldIssueProactiveEnvitOrder(30, {
        trickIndex: 0,
        actor: 2,
        speaker: 0,
        mano: 0,
        envitAlreadyCalled: false,
      }),
    ).toBe(false);

    Math.random = originalRandom;
  });
});