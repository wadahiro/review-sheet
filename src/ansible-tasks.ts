// A file whose CONTENT is written inline in an Ansible task.
//
//     - name: place the drop-in
//       ansible.builtin.copy:
//         dest: /etc/sysctl.d/10-tuning.conf
//         content: |
//           net.ipv4.tcp_keepalive_time = {{ keepalive_time }}
//
// Such a file has no template of its own, so the preview panel had nothing to
// show for it — and the file is as real as any other: it lands on the host, a
// reviewer wants to read it in place, and the values around a line are what
// make it judgeable.
//
// The content is READ from the task, never restated in the spec. A
// `preview_template:` field holding a copy of these lines would work until
// somebody edited the playbook, and then the sheet would show a file that does
// not exist with nothing to catch it — worse than showing none, because a
// preview is a claim that this IS the deployed file. The spec names WHERE to
// look; the answer always comes from the file that actually decides it.
//
// Pure: the caller reads the YAML.

import { parse as parseYaml } from "yaml";

// Both spellings of the module. `copy` is what most playbooks are written with;
// the FQCN is what a linted one uses.
const COPY_MODULES = ["ansible.builtin.copy", "copy"];

export type InlineFile = { content: string; task?: string };

export type InlineFileResult = { file: InlineFile } | { error: string };

type Task = Record<string, unknown>;

const isRecord = (v: unknown): v is Task => typeof v === "object" && v !== null && !Array.isArray(v);

// Tasks nest: `block:`/`rescue:`/`always:` hold more of them, and a role's
// main.yml is often nothing but blocks. Walked rather than assumed flat, so a
// file organised that way is not silently "no such task".
function* walkTasks(node: unknown): Generator<Task> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkTasks(item);
    return;
  }
  if (!isRecord(node)) return;
  yield node;
  for (const key of ["block", "rescue", "always"]) {
    if (key in node) yield* walkTasks(node[key]);
  }
}

// The inline content a task writes to `dest`, or why there is none.
//
// Every failure is reported rather than shrugged off: a preview that quietly
// does not appear looks exactly like a file the project forgot to declare, and
// the point of naming it in the spec was to say it exists.
export function inlineFileFor(tasksYaml: string, dest: string): InlineFileResult {
  let doc: unknown;
  try {
    doc = parseYaml(tasksYaml);
  } catch (e) {
    return { error: `not readable as YAML: ${e instanceof Error ? e.message : String(e)}` };
  }

  const hits: InlineFile[] = [];
  for (const task of walkTasks(doc)) {
    for (const module of COPY_MODULES) {
      const args = task[module];
      if (!isRecord(args)) continue;
      if (args.dest !== dest) continue;
      const content = args.content;
      if (typeof content !== "string") {
        // A `copy:` with `src:` renders no content of its own — it hands over a
        // file that already exists, which is a different thing to preview and
        // not this one.
        return {
          error:
            `the task writing "${dest}" has no inline "content:" ` +
            (typeof args.src === "string" ? `(it copies "${String(args.src)}")` : "(nothing to render)"),
        };
      }
      hits.push({ content, ...(typeof task.name === "string" ? { task: task.name } : {}) });
    }
  }

  if (hits.length === 0) return { error: `no task writes "${dest}"` };
  // Two tasks writing one path is a fact about the playbook worth knowing, and
  // picking one would decide which of them a reviewer is shown.
  if (hits.length > 1) return { error: `${hits.length} tasks write "${dest}" — which of them the file ends as is not decidable here` };
  return { file: hits[0] };
}
