import { describe, it, expect } from "vitest";
import { codexPaneAuth, codexSignInChooser, codexDeviceLogin, codexContinueScreen, codexAuthBroken } from "./codexPane";

// Captured from fny c80b0698 on 2026-09-09, hard wraps and all.
const CHOOSER = `  Welcome to Codex, OpenAI's command-line coding agent
  Sign in with ChatGPT to use Codex as part of your paid p
lan
  or connect an API key for usage-based billing
> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterpri
se plans
  2. Sign in with Device Code
     Sign in from another device with a one-time code
  3. Provide your own API key
     Pay for what you use
  Press enter to continue`;

const DEVICE = `  Welcome to Codex, OpenAI's command-line coding agent
  Finish signing in via your browser
  1. Open this link in your browser and sign in
  https://auth.openai.com/codex/device
  2. Enter this one-time code after you are signed in
(expires in 15 minutes)
  44CI-2EBXY
  Continue only if you started this login in Codex. If a
website or another person gave you this code, cancel.
  Press esc to cancel`;

const CONTINUE = `  Welcome to Codex, OpenAI's command-line coding agent
✓ Signed in with your ChatGPT account
  Before you start:
  Decide how much autonomy you want to grant Codex
  For more details see the Codex docs
  Codex can make mistakes
  Review the code it writes and commands it runs
  Powered by your ChatGPT account
  Uses your plan's rate limits and training data
preferences
  Press enter to continue`;

const BROKEN = `  you specific PRs to review one at a time.
  </joy-message>


■ Your access token could not be refreshed because your
refresh token was already used. Please log out and sign in
again.

• You have 2 usage limit resets available. Run /usage to
use one.


› You are doing an independent security review for`;

const CONVERSATION = `• Explored
  └ Read cache.py
• Working (2m 05s • esc to interrupt)
› Ask Codex to do anything
  gpt-6-astra high · ~/Workspace/vulns`;

describe("codex pane auth", () => {
  it("reads the sign-in chooser with its options", () => {
    expect(codexSignInChooser(CHOOSER)).toEqual(["Sign in with ChatGPT", "Sign in with Device Code", "Provide your own API key"]);
    expect(codexPaneAuth(CHOOSER)).toEqual({ kind: "chooser", options: ["Sign in with ChatGPT", "Sign in with Device Code", "Provide your own API key"] });
  });

  it("reads the device-code screen: link, one-time code, expiry", () => {
    expect(codexDeviceLogin(DEVICE)).toEqual({ url: "https://auth.openai.com/codex/device", code: "44CI-2EBXY", expiresMinutes: 15 });
    expect(codexPaneAuth(DEVICE)?.kind).toBe("device");
    // Its numbered steps are not a chooser.
    expect(codexSignInChooser(DEVICE)).toBeNull();
  });

  it("recognises the post-sign-in continue screen as a bare keypress", () => {
    expect(codexContinueScreen(CONTINUE)).toBe(true);
    expect(codexContinueScreen(CHOOSER)).toBe(false);   // a decision, not a keypress
    expect(codexContinueScreen(DEVICE)).toBe(false);    // needs the browser
    expect(codexPaneAuth(CONTINUE)).toEqual({ kind: "continue" });
  });

  it("reads a dead token in the conversation", () => {
    expect(codexAuthBroken(BROKEN)).toBe("Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.");
    expect(codexPaneAuth(BROKEN)?.kind).toBe("broken");
  });

  it("sees nothing in a working conversation, or through ANSI", () => {
    expect(codexPaneAuth(CONVERSATION)).toBeNull();
    expect(codexPaneAuth("\x1b[1m" + DEVICE.replace("44CI-2EBXY", "\x1b[32m44CI-2EBXY\x1b[0m"))).toMatchObject({ kind: "device", code: "44CI-2EBXY" });
  });
});
