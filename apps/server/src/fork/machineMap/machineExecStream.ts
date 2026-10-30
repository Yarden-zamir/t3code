/**
 * Fork: machine map, the stream of `t3 machine exec` (MM-1919). The CLI opens it on its own
 * server, which runs the command through kitshn (K-722). The frames are in the contract
 * (`MachineExecStreamMessage`). This module holds what both ends share: the frames, a socket
 * that waits for the network before it takes more data, and the keepalive.
 */
import {
  MachineExecStreamChannel,
  MachineExecStreamMessage,
  type MachineExecStreamStart,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

/** Each end pings this often, so a silent stream shows that the other end is still there. */
export const PING_INTERVAL = Duration.seconds(25);
const SILENCE_LIMIT = Duration.seconds(90);
/** Bytes that may wait in a socket before the sender waits for the network. */
const HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_POLL = Duration.millis(10);
const OPEN_TIMEOUT = Duration.seconds(15);

/** The exit codes of ssh: the timeout of `timeout(1)`, and 255 for a stream that failed. */
const EXIT_TIMED_OUT = 124;
export const EXIT_FAILED = 255;

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(MachineExecStreamMessage));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MachineExecStreamMessage));

export const dataFrame = (channel: MachineExecStreamChannel, bytes: Uint8Array) => {
  const frame = new Uint8Array(bytes.byteLength + 1);
  frame[0] = channel;
  frame.set(bytes, 1);
  return frame;
};

export type ExecFrame =
  | { readonly _tag: "data"; readonly channel: number; readonly bytes: Uint8Array }
  | { readonly _tag: "message"; readonly message: MachineExecStreamMessage }
  | { readonly _tag: "invalid" };

export const readFrame = (frame: Uint8Array | string): ExecFrame => {
  if (typeof frame === "string") {
    return Option.match(decodeMessage(frame), {
      onNone: () => ({ _tag: "invalid" }),
      onSome: (message) => ({ _tag: "message", message }),
    });
  }
  const channel = frame[0];
  return channel === undefined
    ? { _tag: "invalid" }
    : { _tag: "data", channel, bytes: frame.subarray(1) };
};

export interface ExecSocket {
  /** The frames as they arrive. Fails when the socket closes. */
  readonly pull: Effect.Effect<ReadonlyArray<Uint8Array | string>, Socket.SocketError>;
  /** Sends a frame, then waits while the socket holds too much: the backpressure of the stream. */
  readonly send: (frame: Uint8Array | string) => Effect.Effect<void, Socket.SocketError>;
  /** Sends a message at once, also when the network is slow, so pings never wait for data. */
  readonly message: (message: MachineExecStreamMessage) => Effect.Effect<void, Socket.SocketError>;
  /** Ends the stream after the frames that wait. */
  readonly close: Effect.Effect<void>;
}

/**
 * An open socket of the stream. `buffered` reads the bytes that wait to go out. Neither the `ws`
 * client nor the upgraded server socket gives Effect a drain signal, so a sender polls it, and only
 * while it is above the mark.
 */
export const execSocket = Effect.fn("MachineExecStream.execSocket")(function* (
  socket: Socket.Socket,
  buffered: () => number,
) {
  const { pull } = yield* socket.reader;
  const writer = yield* socket.writer;
  const drained: Effect.Effect<void> = Effect.suspend(() =>
    buffered() <= HIGH_WATER_BYTES
      ? Effect.void
      : Effect.andThen(Effect.sleep(DRAIN_POLL), drained),
  );
  return {
    pull,
    send: (frame) => Effect.andThen(writer.write(frame), drained),
    message: (message) => writer.write(encodeMessage(message)),
    close: writer.write(new Socket.CloseEvent(1000)).pipe(Effect.ignore),
  } satisfies ExecSocket;
});

const bufferedAmount = (webSocket: Socket.WebSocketLike) =>
  "bufferedAmount" in webSocket && typeof webSocket.bufferedAmount === "number"
    ? webSocket.bufferedAmount
    : undefined;

/** Opens the stream route of a server as a client. Fails when the server refuses the upgrade. */
export const openExecSocket = Effect.fn("MachineExecStream.openExecSocket")(function* (
  url: string,
  headers: Readonly<Record<string, string>>,
) {
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const webSocket = makeWebSocket(url, { headers: { ...headers } });
  if (bufferedAmount(webSocket) === undefined) {
    return yield* Effect.die("The WebSocket client does not report its buffered bytes.");
  }
  const socket = yield* Socket.fromWebSocket(
    Effect.acquireRelease(Effect.succeed(webSocket), (opened) =>
      Effect.sync(() => {
        // `ws` emits "error" when a socket closes before it opens, and an unheard "error" ends
        // the whole process.
        opened.addEventListener("error", () => {});
        opened.close(1000);
      }),
    ),
    { openTimeout: OPEN_TIMEOUT },
  );
  return yield* execSocket(socket, () => bufferedAmount(webSocket) ?? 0);
});

/** The ws URL of the stream route on the server of `httpUrl`. */
export const streamUrl = (httpUrl: string, path: string) => {
  const url = new URL(path, httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/**
 * The keepalive of one end. Each end pings every `PING_INTERVAL` and counts any frame from the
 * other end as alive. Silence counts only while this end waits for nothing of its own: a command
 * that does not read its stdin, or a slow reader of the CLI's stdout, stops the frames of the other
 * end on purpose.
 */
export const makeLiveness = Effect.gen(function* () {
  let lastFrameAt = yield* Clock.currentTimeMillis;
  let waitingHere = 0;
  const touch = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.sync(() => {
      lastFrameAt = now;
    }),
  );
  const whileWaitingHere = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        waitingHere += 1;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          waitingHere -= 1;
        }).pipe(Effect.andThen(touch)),
    );
  /** Pings until the other end is silent for `SILENCE_LIMIT`, then completes. */
  const watch = Effect.fn("MachineExecStream.watch")(function* <E>(ping: Effect.Effect<void, E>) {
    while (true) {
      yield* Effect.sleep(PING_INTERVAL);
      const silentFor = (yield* Clock.currentTimeMillis) - lastFrameAt;
      if (waitingHere === 0 && silentFor > Duration.toMillis(SILENCE_LIMIT)) return;
      yield* ping;
    }
  });
  return { touch, whileWaitingHere, watch };
});

export interface ExecClientResult {
  readonly exitCode: number;
  /** Why the stream failed or stopped, for stderr. */
  readonly message?: string;
}

/**
 * The CLI end: sends `start`, then stdin with an `eof`, writes stdout and stderr as they arrive, and
 * ends with the exit code of the command. A stream that ends without `exit` fails with 255.
 */
export const runExecClient = Effect.fn("MachineExecStream.runExecClient")(function* <E>(input: {
  readonly socket: ExecSocket;
  readonly start: MachineExecStreamStart;
  readonly stdin: Stream.Stream<Uint8Array, E>;
  /** Writes output here. A write that fails ends the run with its result. */
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void, ExecClientResult>;
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void, ExecClientResult>;
}): Effect.fn.Return<ExecClientResult, never, Scope.Scope> {
  const { socket } = input;
  const liveness = yield* makeLiveness;
  const failed = (message: string): ExecClientResult => ({ exitCode: EXIT_FAILED, message });
  const sendStdin = input.stdin.pipe(
    Stream.runForEach((bytes) => socket.send(dataFrame(MachineExecStreamChannel.stdin, bytes))),
    // A local stdin that fails ends like one that ended: the command sees EOF.
    Effect.ignore,
    Effect.andThen(socket.message({ type: "eof" })),
    Effect.ignore,
  );
  const receive = Effect.gen(function* () {
    while (true) {
      const frames = yield* socket.pull;
      yield* liveness.touch;
      for (const raw of frames) {
        const frame = readFrame(raw);
        if (frame._tag === "data" && frame.channel === MachineExecStreamChannel.stdout) {
          yield* liveness.whileWaitingHere(input.stdout(frame.bytes));
          continue;
        }
        if (frame._tag === "data" && frame.channel === MachineExecStreamChannel.stderr) {
          yield* liveness.whileWaitingHere(input.stderr(frame.bytes));
          continue;
        }
        if (frame._tag !== "message") {
          return failed("The other machine sent a frame that is not valid.");
        }
        const { message } = frame;
        if (message.type === "error") return failed(message.message);
        if (message.type === "waiting") {
          yield* input.stderr(
            new TextEncoder().encode(
              `t3 machine exec: waiting for the owner's approval on kitshn (proposal ${message.proposalId}).\n`,
            ),
          );
          continue;
        }
        if (message.type !== "exit") continue;
        if (message.outcome === "timedOut") {
          return { exitCode: EXIT_TIMED_OUT, message: "The command reached its timeout." };
        }
        if (message.outcome === "stopped") {
          return failed(message.message ?? "The other machine stopped the command.");
        }
        // A command that a signal ended has no exit code.
        return message.exitCode === null
          ? failed(message.message ?? "A signal ended the command.")
          : { exitCode: message.exitCode };
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Predicate.isTagged(error, "SocketError")
          ? failed("The connection closed before the command ended.")
          : error,
      ),
    ),
  );
  const silent = liveness.watch(socket.message({ type: "ping" })).pipe(
    Effect.as(failed(`No answer for ${Duration.format(SILENCE_LIMIT)}. The connection is lost.`)),
    Effect.orElseSucceed(() => failed("The connection closed before the command ended.")),
  );
  yield* socket.message(input.start).pipe(Effect.ignore);
  yield* Effect.forkScoped(sendStdin);
  return yield* Effect.raceFirst(receive, silent);
});
