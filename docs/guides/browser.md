# Your browser

An agent can act in your own browser: read a page you are logged in to, fill a form, click through a flow, or change how a site looks every time you visit it. The Joy Browser extension makes that possible, in Chrome and in Firefox. It ties one session to your browser, puts a small chat button on the pages you visit, and runs the scripts that session's agent writes.

The agent does not need to be on the same machine as the browser. The extension is a client of your account and talks to your relay, exactly as the app does, so nothing on your computer is opened to the network. In [Direct mode](#direct-mode), it talks to the machine itself instead.

## Set it up

1. Install the extension (see [Install the extension](#install-the-extension)).
2. Click the extension's icon. Enter your relay's address and your backup code, then press **Continue**. Your backup code is in the app under Settings → Account.
3. Pick the machine your session should run on, and a folder for it. The folder is created if it does not exist. Pick the **Connection**: **Relay** (the default) or **Direct** (see [Direct mode](#direct-mode)). Press **Start my session**.

The extension starts a [headless session](sessions.md#headless-sessions) on that machine and links it to this browser. Your details and the link are remembered until you press **Clear everything**, so you do this once. If the session ever ends, the extension starts a fresh one in the same folder by itself.

## Direct mode

In Direct mode, the browser connects straight to the machine over WebRTC, and your messages never pass through the relay. Choose **Direct** as the **Connection** when you set up.

- The relay only helps the browser and the machine find each other. It carries one sealed offer and one sealed answer, which it cannot read or change. After that, prompts, answers and the session's history go from the browser to the machine and back.
- The session is local-only. It does not appear in the app, and it sends no notifications. Its history is kept only on the machine.
- Everything else works the same: the chat button, scripts, saved scripts, excluded sites and Pause.
- The machine's daemon must be recent enough to accept direct connections. Run `joy update` on it.

The two ends find a route with the help of a STUN server, Cloudflare's by default. On the machine, set `JOY_STUN_URLS` to a comma-separated list of other servers, or to `off` to use the local network only. Some networks block every direct route between two devices. Then the connection fails, and Direct mode does not fall back to the relay. Use Relay mode on such a network.

## Talk to your session

A round **J** button appears on every page. Click it to open a chat panel, and type what you want done: "what plan are we on?", "fill this form from my last invoice", "hide the sidebar on this site". Drag the button anywhere; it stays where you put it, on every site.

The panel shows the conversation with the browser's own traffic folded away. A script the agent ran is one line you can open to read, and so is the browser's answer. When the agent offers choices, they appear as buttons. In Relay mode, the same conversation is in the app, like any other session.

The dot on the button is green when the session is idle, yellow while it works, grey when you paused the browser, and red when the link is broken. Open the extension's popup to see why.

## What happens when the agent uses it

The agent ends its turn with a script between `<joy-browser-execute>` tags. The extension runs the script in the active tab, or in a tab the agent names, or in a new tab at a URL the agent gives. The outcome comes back into the session as a message marked `from="browser"`, with the page it ran on, the value the script returned, and anything it logged. The agent reads that and continues.

Because the result arrives as a new message, each script is one round trip through the [queue](messages.md#the-queue).

In Chrome, a bar says Joy Browser is debugging the browser while a script runs. That is how Chrome allows an extension to run a script it was handed, and the bar disappears when the script finishes. Firefox shows nothing.

## Scripts that stay

Ask the agent to make a change permanent, for example "always hide the sidebar on example.com". The agent tries the script first, then asks the browser to remember it, with a name and the sites it is for.

A remembered script does nothing until you approve it. The chat panel shows a card with the script's name, its sites and its code, and **Approve** or **Reject**. The agent cannot approve its own script, and a script the agent later changes needs your approval again. Once approved, it runs on every visit to those sites, with nobody watching.

**Settings → Saved scripts** in the popup lists every script. Turn one off, read it, or delete it there.

## Excluded sites and Pause

**Settings → Excluded sites** is a list of sites that are closed to the agent. On an excluded site there is no chat button, the agent's scripts are refused, saved scripts do not run, and the site's tabs are left out when the agent asks what is open. The agent is told the site is excluded and not to work around it.

Add a site by typing it in, or press **Hide on this site** in the chat panel. `bank.com` covers `bank.com` and every subdomain. `example.com/account/*` covers only that part of the site. Add your bank, your email and anything else you would not hand to an assistant.

**Pause** stops everything at once: no script runs, and saved scripts stay quiet, until you press **Resume**. The button is in the popup and in the chat panel.

## Use a different session

**Settings → Session** links the browser to a session you already have. The sessions this browser used before are listed there with a **Connect** button, so switching back needs no id. For any other session, enter the id the app and `joy ls` show, and press **Connect**. The session is told a browser attached. **Start a fresh session** replaces the linked session with a new one.

## What is safe and what is not

- Only the agent's own reply can run a script or ask to save one. Text you type, text another session sends, the agent's thinking, and a tag shown inside a code block never run. A page cannot get a script run by printing one.
- A browser only acts on what the agent writes after the link was made. Earlier messages are ignored.
- A script never runs twice. If the browser closes in the middle of one, the agent gets no answer and may ask again, but a click or a submitted form is not repeated.
- Scripts run in your real browser with your logins. The agent is told to treat page content as data and not to buy, send, submit or delete anything you did not ask for. A hostile page can still try to mislead an agent. Excluded sites are your protection against that: a site on the list cannot be reached, whatever the agent was told.
- A saved script runs without you watching. Read it before you approve it.
- Your backup code is your whole account, and the extension keeps it in the browser profile so it can sign in again by itself. Pair only a profile you trust. **Clear everything** removes it, along with the link, your excluded sites and your saved scripts.

## Install the extension

The extension is in `packages/joy-browser` in the joy repository.

**Chrome, Edge, Brave.** Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the `packages/joy-browser` folder.

**Firefox.** Firefox installs only extensions that Mozilla signed. Signing is free, takes a few minutes, and does not list the extension publicly:

1. Create API credentials at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
2. In `packages/joy-browser`, run `WEB_EXT_API_KEY=<JWT issuer> WEB_EXT_API_SECRET=<JWT secret> pnpm sign:firefox`.
3. Open the `.xpi` file from `dist/signed/` in Firefox.

An add-on id belongs to the Mozilla account that first signs it. If you are not the owner of `joy-browser@faraz.vip`, change the id in `manifest.firefox.json` to one of your own before you sign. To try the extension without signing, run `pnpm build`, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`. A temporary add-on is removed when Firefox closes.

## If nothing happens

- **The agent never uses the browser.** Sessions learn how from their machine's daemon. Run `joy update` on that machine. For a session that was already running, send `/joy-prompt` to refresh its instructions.
- **"Could not pair: could not reach …".** The request never reached a relay. The address is what was tried, with `https://` added when you typed none. Check that the address is complete (usually `relay.example.com:4997`, not a nickname), and open `<address>/joy/v2/capabilities` in a normal tab of the same browser: a relay answers with a short JSON line. If the tab works and the extension does not, the browser is not letting the extension make the request. In Orion, give the extension access to all websites in its settings.
- **"… does not know this backup code".** The relay answered, but this account is not on it. Use the relay the app is signed in to (Settings → Account shows it).
- **"Start my session" fails.** The machine must be online, with a daemon that can start Claude Code. Run `joy doctor` on it.
- **A script takes a while to run in Chrome.** Chrome puts idle extensions to sleep and wakes this one every 30 seconds. While the chat panel is open, the extension stays awake and responds at once. Firefox does not sleep.
- **"this page cannot be scripted".** Browser pages such as `chrome://` and `about:` addresses and the browsers' add-on stores cannot be scripted. Have the agent open the page it needs.
- **"no direct route to the machine".** Direct mode could not connect the browser and the machine. A firewall or the network blocks it. Use Relay mode, or try from another network.
- **"this machine's daemon is too old for Direct mode".** Run `joy update` on the machine.
- **No chat button on a page.** The site is on your excluded list, or setup is not finished. The button also does not appear on browser pages.

## Related

- [Sessions](sessions.md)
- [Messages and the queue](messages.md)
- [Scripting and agents](scripting-and-agents.md)
- [Security](../reference/security.md)
