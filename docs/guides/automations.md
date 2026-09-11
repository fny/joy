# Automations

An automation is saved work: a folder, a prompt and a trigger. When the trigger fires, joy starts a headless session in that folder on that machine, sends the prompt, and records the outcome as a run. This page covers creating and editing automations from the app and the command line, the three triggers, how schedules behave, reading run history, and what each kind of failure means.

## How a run works

Each run is an ordinary session with two differences:

- **It is headless.** Nobody is expected to watch it, so it stays out of your main session list and sends no "Finished" notification. While it runs it appears in the **Automations** section of the sidebar, under **Show automations**, and it leaves the list on its own when it succeeds.
- **It starts with prompts off, and stopping for a human is a failure.** An unattended run that waits at a login screen or a permission prompt would sit there unnoticed. Instead, the moment a run needs you, it is marked failed with a reason you can act on.

You can open a run's session like any other to read what it did.

## Creating an automation in the app

Go to **Settings → Automations** and tap **New automation**. Fill in:

| Field | Notes |
|---|---|
| Name | Required. What you look for in the list, and what failures are reported under. |
| Machine | Where the automation runs. It has to be online while you create it. |
| Folder | An absolute path or `~/…`. |
| Prompt | What the agent is asked to do on every run. |
| When | The trigger; see [Triggers](#triggers). |
| Agent | Which agent runs it. |

Tap **Create automation**. To change one later, open it in **Settings → Automations** and tap **Edit**. You can change the name, folder, machine, prompt and trigger.

## Creating an automation from the command line

Run this on the machine that should do the work:

```bash
joy automation create -m "run the tests and fix what breaks" --name "nightly tests" \
  --dir ~/code/my-project --cron "0 2 * * *" --tz America/New_York
```

| Flag | Meaning |
|---|---|
| `-m "<prompt>"` | Required. The prompt for every run. |
| `--dir <path>` | The folder. Defaults to the current directory. |
| `--name <name>` | The name. Defaults to the prompt's first few words. |
| `--cron "<expr>"` | Run on a schedule. |
| `--tz <zone>` | The schedule's time zone, such as `Europe/Berlin`. Defaults to UTC. |
| `--on manual` | Run only when asked. This is the default without `--cron`. |
| `--on automation_done --filter <id>` | Run after another automation finishes. |
| `--agent`, `--model`, `--effort` | The agent and its settings. The agent defaults to Claude Code. |
| `--json` | Print the created automation as JSON. |

The command prints the automation's full id, its next scheduled time if it has one, and the command to run it now. The other subcommands take that full id; `joy automation ls` shows only the first eight characters, and `joy automation ls --json` shows the whole id.

Other subcommands:

| Command | What it does |
|---|---|
| `joy automation ls` | List automations with their trigger and latest result. |
| `joy automation show <id>` | Everything about one automation, as JSON. |
| `joy automation run <id>` | Start a run now and print its id. |
| `joy automation runs <id>` | The run history. |
| `joy automation enable <id>`, `disable <id>` | Turn the triggers on or off. |
| `joy automation rm <id>` | Delete the automation and its history. |

### An automation belongs to one machine

The prompt and settings are encrypted with the key of the machine that runs them, so only that machine, and your devices signed in to your account, can read them. `joy automation create` always creates an automation for the machine you run it on. From the app you can create one for any of your machines.

A device that cannot read an automation's prompt shows "Prompt not readable on this device". You can still rename it and change its folder and trigger there.

## Triggers

| In the app | On the command line | Fires |
|---|---|---|
| Only when I ask | `--on manual` | When you tap **Run now** in the app, or run `joy automation run <id>`. |
| On a schedule | `--cron "<expr>" [--tz <zone>]` | At the times the cron expression names, in the time zone you give. |
| After another automation | `--on automation_done --filter <id>` | When a run of the automation with that id finishes, whatever its outcome. |

The app's version of **After another automation** does not yet let you choose which automation to follow, so it fires after any automation finishes. To chain one automation behind a specific other one, create it from the command line with `--filter`.

### Schedules

A schedule is a standard five-field cron expression:

```text
┌ minute (0–59)
│ ┌ hour (0–23)
│ │ ┌ day of month (1–31)
│ │ │ ┌ month (1–12)
│ │ │ │ ┌ day of week (0–6, Sunday = 0; 7 is also Sunday)
* * * * *
```

Each field takes `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, and comma-separated lists of these. Month and day names are not accepted.

| Expression | Runs |
|---|---|
| `0 2 * * *` | Every day at 2:00. |
| `*/15 * * * *` | Every fifteen minutes. |
| `0 9 * * 1-5` | Weekdays at 9:00. |
| `30 18 * * 0` | Sundays at 18:30. |

An expression that does not parse, or a time zone that does not exist, is rejected when you save, not months later.

**Time zones are real.** "2:00" means 2:00 on the wall clock in the zone you name, across daylight-saving changes. When the clocks go back and an hour repeats, a schedule inside that hour runs once, not twice.

**A backlog is never replayed.** If the relay was down while occurrences came due, the schedule runs once when it is back, and the history records how many occurrences passed while nothing was listening. A five-minute schedule does not owe you a stampede of runs after an outage.

**Runs never overlap.** If a trigger fires while the automation's previous run is still going, including a run waiting for its machine to come online, the new firing is recorded as skipped instead of starting a second run.

## Runs and history

In **Settings → Automations**, tap an automation to see its runs, newest first, each with when it started, what triggered it, and the reason for any failure. The automation's row also offers **Run now**, **Edit**, **Disable** or **Enable**, and **Delete**. Deleting an automation removes it and its run history; the sessions its runs produced are left alone.

A disabled automation fires nothing. Runs already going are not affected.

## Failures

When a run fails, it moves to **Automation failures** at the top of the sidebar, above Pinned, and stays there so it cannot go unnoticed. The row says what went wrong. To clear it, delete the run's session from its session info.

| Code | Meaning | What to do |
|---|---|---|
| `blocked:login` | The agent on the machine needs to be signed in. One expired sign-in fails every automation on that machine. | Sign the agent in on the machine, or open any session there and use its sign-in bar. |
| `blocked:trust` | The agent was asked whether to trust the folder. It has never been told this folder is safe. | Start one ordinary session in the folder and accept the trust prompt once. |
| `blocked:permission` | A dialog or an approval request was waiting. | Check the prompt asks for something the agent can do without approval, or adjust the agent's configuration. |
| `agent_died` | The agent process exited. | Open the run's session to see its last output. |
| `stalled` | The turn stayed open with no output for 30 minutes. | Open the run's session; the agent may be stuck on a long command. |

A skipped firing is recorded as a cancelled run with a note, not as a failure.

## Using runs from scripts and other agents

`joy automation run <id> --wait` blocks until the run finishes and exits with its outcome, so a shell script or another agent can call an automation without parsing anything:

```bash
if joy automation run "$AUTOMATION_ID" --wait; then
  echo "tests passed"
else
  echo "tests failed"
fi
```

It exits 0 when the run succeeded and 1 otherwise, printing the failure code and reason. It waits up to 30 minutes. Add `--json` to print the finished run as JSON.

## Related

- [Sessions](sessions.md), including [headless sessions](sessions.md#headless-sessions)
- [Notifications](notifications.md)
- [Scripting and agents](scripting-and-agents.md)
- [CLI reference](../reference/cli.md)
- [Troubleshooting](../reference/troubleshooting.md)
