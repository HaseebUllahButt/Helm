/**
 * When a message typed while an agent works reaches its CLI.
 *
 * Shared by the daemon, which hands messages over at that point, and the
 * app, which says so on each waiting message. `tool`: handed over while a
 * tool step runs and read when it ends (Codex's turn/steer; Claude reading
 * its input after the tool batch). `loop`: joins the running agent loop at
 * its next step (OpenCode 1, a second ACP prompt). `turn`: every other CLI,
 * where no mid-turn input has been verified, so it waits for the reply.
 */
const delivery = (timing, pending) => Object.freeze({ timing, pending });
const AT_TURN_END = delivery('turn', 'After current response');
const MID_TURN = Object.freeze({
  codex: delivery('tool', 'After next tool call'),
  claude: delivery('tool', 'After current tools finish'),
  opencode: delivery('loop', 'At next agent step'),
});

export function messageDelivery(engine) {
  return typeof engine === 'string' && Object.hasOwn(MID_TURN, engine) ? MID_TURN[engine] : AT_TURN_END;
}
