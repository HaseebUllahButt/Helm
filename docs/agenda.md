# Helm improvement agenda

The owner wants less repeated setup and a local browser assistant.
Keep the first assistant trial in a local Linux VM.
Use Helm's existing chats, helpers, browser tools, saved flows and machine links.

## Reduce repeated work

Recent chat summaries show repeated reviews, project changes and work across three active machines.
These are proposals, not claims about measured time savings.

1. Offer saved review skills as visible actions. Store the chosen accounts, models and task roles.
   Start a saved team from one task, with one lead responsible for the result.
   Keep each helper visible and openable inside its parent chat.
   Reuse the existing review and release skills. Show the selected task before starting work.
   Keep release actions explicit. Do not add another automation system.
2. Show “New chat in this folder” in an open chat, beside the existing keyboard shortcut.
   Reuse the selected project, machine and account. Make this available on phones.
   The existing “Continue in a new chat” action already covers finished sidebar chats.
3. Save unfinished project sends. Reopen their status after leaving the screen.
   Keep the same send identity when a reply is lost. First prove duplicate prevention across a restart.
4. Keep snoozed requests consistent across devices.
   A request hidden on the laptop should stay hidden on the phone until its snooze ends.

## Build the local assistant in stages

1. Run a trial in one manually created Linux VM.
   Joining machines and keeping browser profiles already exist.
   The new work is proving one read-only research task and one reversible website task there.
2. Decide how the owner completes sign-in or human verification.
   One option is owner takeover of the same browser.
   Pause agent actions while the owner has control. Resume only when the owner returns control.
   Takeover needs a separate owner decision. Earlier decisions exclude remote browser pictures in Helm.
   Do not add remote viewing as part of this review.
   Keep passwords outside chat. Do not automatically copy host credentials or folders into the VM.
3. Save the result of each browser step that changes a site.
   Require a site-specific check before repeating a submission after a lost reply.
   If that check cannot confirm the result, stop and ask the owner.
   Reuse saved flows and the existing machine-side schedule system.
   Do not restore the removed schedule screen without an owner request.
4. Restore saved browser tabs only when needed.
   Keep every tab. Measure restart cost before changing restoration behavior.
5. Package VM setup after the manual trial succeeds.
   Show start, stop, status, storage use and recovery.
   Prove guest reboot, host sleep, lost connections, browser restart and owner takeover.

A VM at home can use the home's internet connection.
A hosted VM normally uses the host provider's connection.
Neither location guarantees that a website accepts automation.
The current browser already uses full Chromium. Prove its behavior on the target websites.
Give the owner a clear blocked step instead of retrying human checks indefinitely.

## Support more operating systems

1. Prove the Linux guest on each supported host first.
   Host support and guest support are separate promises.
2. Test macOS on a real Mac.
   Background startup exists. Check restart, browser discovery, window control and saved sign-ins.
   The browser discovery regression test uses a simulated Mac filesystem.
   Prove the external browser window on each supported desktop.
3. Treat native Windows as a separate project.
   It still needs background startup, a Windows shell, process connections and browser cleanup.
   Windows browser sign-in copying also needs its own supported path.
   Do not describe a working Linux guest as native Windows support.

## Remaining proof

Check whether changing a model can send an unsupported thinking level.
Current source retains that setting; provider rejection has not been reproduced.
Check whether a window opened on another machine needs an explicit notice.
That behavior follows the present browser design and is not a confirmed routing bug.

## Reference and boundaries

The likely reference is [Grok Bot](https://docs.x.ai/grok-bot/overview).
Its [computer model](https://docs.x.ai/grok-bot/computer-and-apps) combines persistent work, saved sign-ins and owner takeover.
The owner has not confirmed the product identity.
This agenda proposes similar behavior inside Helm, not a new dependency on Grok Bot or its cloud.

The review did not run a new VM or test real macOS, native Windows or owner takeover.
