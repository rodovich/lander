import type {
  HookRunResultMessage,
  HooksResolveResultMessage,
  ProjectGrantResultMessage,
} from '../server/protocol'

// The daemon's answers to requests the server holds open until a reply arrives.
export type ReplyMessage =
  | ProjectGrantResultMessage
  | HooksResolveResultMessage
  | HookRunResultMessage

export type ReplyBody<T extends ReplyMessage['type']> = Omit<
  Extract<ReplyMessage, { type: T }>,
  'type' | 'requestId'
>

// Answer one server request, whatever its handler does: a returned body is sent
// as-is, and a synchronous throw or a rejection becomes a 500. Every outcome has
// to become a reply. A throw that escaped would crash the daemon inside its
// WebSocket listener, dropping every run it holds; one that was swallowed would
// leave the server waiting out its timeout. Resolves once the reply is sent.
export function createReply(send: (msg: ReplyMessage) => void) {
  return function reply<T extends ReplyMessage['type']>(
    type: T,
    requestId: string,
    handle: () => ReplyBody<T> | Promise<ReplyBody<T>>,
  ): Promise<void> {
    return new Promise<ReplyBody<T>>((resolve) => resolve(handle()))
      .catch((e): ReplyBody<T> => {
        console.error(`daemon: error handling ${type} ${requestId}:`, e)
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          status: 500,
        } as ReplyBody<T>
      })
      .then((body) => send({ type, requestId, ...body } as ReplyMessage))
  }
}
