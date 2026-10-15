/**
 * Auto INTENT replays (SPEC §4.3.1): each reply kept by holder key and frame id, so a repeat gets
 * the original reply and never commits twice.
 */
import type { FinalReply } from '../../types.js';
import { replayOf } from '../replies.js';

/** The verified holder key and frame id of an auto INTENT, and its proof's `ts`. */
export interface AutoReplay {
  key: string;
  proofTs: number;
}

/** Past this many replies kept, a new one prunes those past `exp`. */
const PRUNE_AT = 10_000;

export class AutoReplies {
  private readonly replies = new Map<
    string,
    { reply: Promise<FinalReply>; exp: number }
  >();

  /**
   * The original reply for a repeat, or `answer()`'s, kept until 900s past the later of `now`
   * and the proof's `ts`: that outlives every proof that could carry this frame id.
   */
  async answerOnce(
    replay: AutoReplay,
    re: string,
    answer: () => Promise<FinalReply>,
    now: number,
  ): Promise<FinalReply> {
    const prior = this.replies.get(replay.key);

    if (prior && prior.exp > now) {
      return replayOf(await prior.reply, re);
    }

    const reply = answer();

    this.replies.set(replay.key, {
      reply,
      exp: Math.max(now, replay.proofTs) + 900,
    });

    if (this.replies.size > PRUNE_AT) {
      this.forget(now);
    }

    return reply;
  }

  /** Forget replies past `exp`. */
  forget(now: number) {
    for (const [k, v] of this.replies) {
      if (v.exp <= now) {
        this.replies.delete(k);
      }
    }
  }
}
