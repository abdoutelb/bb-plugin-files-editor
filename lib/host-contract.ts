import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The plugin's `bb.host` entry: the part that touches the disk. BB starts it
 * on whichever machine a workspace lives on — this one or a connected one — so
 * listing and searching read files where they are, with no guess about which
 * machine that is.
 */

/** How many entries a listing returns before it reports itself truncated. */
export const ENTRY_LIMIT = 40_000;

export const entrySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});

const lineMatchSchema = z.object({
  line: z.number(),
  column: z.number(),
  preview: z.string(),
  ranges: z.array(z.tuple([z.number(), z.number()])),
  clippedStart: z.boolean(),
  clippedEnd: z.boolean(),
});

export const searchOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    files: z.array(
      z.object({
        path: z.string(),
        matchCount: z.number(),
        matches: z.array(lineMatchSchema),
      }),
    ),
    totalMatches: z.number(),
    searchedFiles: z.number(),
    truncated: z.boolean(),
    reason: z.enum(["matches", "files", "time", "listing"]).nullable(),
    durationMs: z.number(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
  z.object({ status: z.literal("cancelled") }),
]);

const listingInput = {
  root: z.string().min(1),
  includeHidden: z.boolean(),
  excludedNames: z.array(z.string()),
};

export const hostContract = defineRpcContract({
  /** Every file and directory under `root`, breadth-first, up to {@link ENTRY_LIMIT}. */
  list: {
    input: z.object(listingInput).strict(),
    output: z.object({ entries: z.array(entrySchema), truncated: z.boolean() }),
  },
  /** Text search across the files `list` would return. */
  search: {
    input: z
      .object({
        ...listingInput,
        query: z.string().max(1000),
        matchCase: z.boolean(),
        wholeWord: z.boolean(),
        regex: z.boolean(),
      })
      .strict(),
    output: searchOutcomeSchema,
  },
  /** After a save: the next search must see what was written. */
  forget: {
    input: z.object({ absolutePath: z.string().min(1) }).strict(),
    output: z.null(),
  },
});
