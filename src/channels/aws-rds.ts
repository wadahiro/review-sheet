// Where a row of an infrastructure sheet sits in what the RDS API returns.
//
// A row is named by the address its SOURCE uses — a Terraform module, a
// resource type, an argument (`aurora.aws_rds_cluster_parameter_group.this.
// parameter[name=max_connections].value`) — and the API that can be asked about
// the same thing names every field something else
// (`Parameters[ParameterName=max_connections].ParameterValue`). That relation
// is AWS's and the provider's, identical in every project that reviews an RDS
// cluster, and it CANNOT be inferred: `backup_retention_period` ->
// `BackupRetentionPeriod` looks like a rule until
// `db_cluster_parameter_group_name` -> `DBClusterParameterGroup`, and a rule
// that is right most of the time answers the wrong field in silence.
//
// So it is a table, held once here rather than copied into each project's
// judging script where no test of this tool reaches it. A row this table does
// not name is NOT answered — never guessed at — and the project says what it
// wants said about it.
//
// IT JUDGES, IT DOES NOT REACH. Asking AWS needs credentials, a region and the
// resource's own identity (which is a value the sheet carries per environment,
// not something a key can produce), so the asking stays with whoever collects.
// What arrives is the API's reply, verbatim, as a document.

import { registerDocumentRouter, registerFunctionalChannel, type DocumentRouter, type FunctionalAnswer } from "../channel.js";
import { wordsFor, type ChannelWords } from "../channel-words.js";
import type { TestItem } from "../testplan.js";

// A resource's own attributes, by the type that holds them. The KEY is the
// argument as the Terraform provider spells it; the value is where the API puts
// it. `[0]`: every one of these is asked about ONE named resource, so the reply
// carries exactly one.
const CLUSTER_PARAMETER_GROUP: Record<string, string> = {
  name: "DBClusterParameterGroups[0].DBClusterParameterGroupName",
  family: "DBClusterParameterGroups[0].DBParameterGroupFamily",
  description: "DBClusterParameterGroups[0].Description",
};

const CLUSTER: Record<string, string> = {
  // The row that makes a parameter group matter: a group can be perfectly
  // correct and attached to nothing.
  db_cluster_parameter_group_name: "DBClusters[0].DBClusterParameterGroup",
};

// …and the parameters inside a group, which are a LIST the API identifies by
// `ParameterName` — not one of this tool's built-in identity fields, and not
// the project's business to know, so the route states it.
const PARAMETER: Record<string, string> = {
  value: "ParameterValue",
  apply_method: "ApplyMethod",
};

// `<module>.<type>.<name>.<rest>` — the shape `recipes/terraform-plan.ts` keys a
// plan row by. Matched on the TYPE and the argument only: which module a
// resource sits in, and what the project called it, are the project's.
const GROUP_PARAM = /\.aws_rds_cluster_parameter_group\.[^.]+\.parameter\[name=([^\]]+)\]\.([a-z_]+)$/;
const GROUP_ATTR = /\.aws_rds_cluster_parameter_group\.[^.]+\.([a-z_]+)$/;
const CLUSTER_ATTR = /\.aws_rds_cluster\.[^.]+\.([a-z_]+)$/;

export const awsRdsRouter: DocumentRouter = {
  name: "aws-rds",
  route: (item: TestItem) => {
    const key = item.target.key;
    const p = GROUP_PARAM.exec(key);
    if (p !== null) {
      const field = PARAMETER[p[2]!];
      return field === undefined
        ? undefined
        : {
            document: "describe-db-cluster-parameters",
            address: `Parameters[ParameterName=${p[1]!}].${field}`,
            idFields: ["ParameterName"],
          };
    }
    const g = GROUP_ATTR.exec(key);
    if (g !== null) {
      const where = CLUSTER_PARAMETER_GROUP[g[1]!];
      return where === undefined ? undefined : { document: "describe-db-cluster-parameter-groups", address: where };
    }
    const c = CLUSTER_ATTR.exec(key);
    if (c !== null) {
      const where = CLUSTER[c[1]!];
      return where === undefined ? undefined : { document: "describe-db-clusters", address: where };
    }
    return undefined;
  },
};

export function registerAwsRdsRouter(): void {
  registerDocumentRouter(awsRdsRouter);
}

// ---------------------------------------------------------------------------
// WHAT A ROW COMPARISON CANNOT SAY, even in principle: a sheet names the
// parameters a design decided, the group holds several hundred, and somebody
// changing a different one from the console appears in none of the rows. The
// API reports each parameter's SOURCE, so the question has an answer — and
// `user` meaning "somebody set this" is RDS's, not one project's.
//
// The set the design authored is the PLAN's, read through the same table the
// router uses. A project keeping its own copy of that pattern is the hazard
// this whole file exists to remove.
function authoredAnswer(hosts: Record<string, unknown>, items: TestItem[], sheet: string, w: ChannelWords): FunctionalAnswer {
  for (const [host, held] of Object.entries(hosts)) {
    const doc = ((held as { documents?: { name?: string; how?: string; text?: string; absent?: string }[] }).documents ?? []).find(
      (d) => d.name === "describe-db-cluster-parameters"
    );
    if (doc === undefined) continue;
    if (doc.absent !== undefined) return { status: "not_run", reason: doc.absent };
    let body: { Parameters?: { ParameterName?: string; Source?: string }[]; Marker?: string };
    try {
      body = JSON.parse(doc.text ?? "{}") as typeof body;
    } catch {
      return { status: "not_run", reason: w.parametersUnreadable() };
    }
    // A PAGE IS NOT THE LIST. `describe-db-cluster-parameters` is paginated and
    // a group holds several hundred parameters, so a reply that carries a
    // `Marker` is the API saying there is more — and this item is precisely
    // "is there anything here we did not decide", which a first page cannot
    // answer. Refused rather than answered from part of the data: the pass it
    // would otherwise produce is the failure mode this item exists to catch.
    if (typeof body.Marker === "string" && body.Marker !== "") {
      return { status: "not_run", reason: w.parametersPaginated() };
    }
    // The VALUE rows, not every row that names a parameter: `apply_method` says
    // HOW a change takes effect, which is not a statement that the value was
    // changed at all — and a group holds the apply_method of parameters nobody
    // touched.
    const authored = new Set(
      items
        .filter((i) => i.target.sheet === sheet)
        .map((i) => GROUP_PARAM.exec(i.target.key))
        .filter((m): m is RegExpExecArray => m !== null && m[2] === "value")
        .map((m) => m[1]!)
    );
    const changed = (body.Parameters ?? []).filter((p) => p.Source === "user").map((p) => p.ParameterName!);
    const extra = changed.filter((n) => !authored.has(n));
    const missing = [...authored].filter((n) => !changed.includes(n));
    const ok = extra.length === 0 && missing.length === 0;
    return {
      status: ok ? "pass" : "fail",
      detail: w.authoredDetail((body.Parameters ?? []).length, changed.length),
      ...(ok
        ? {}
        : {
            reason: [
              extra.length > 0 ? w.authoredExtra(extra.join(", ")) : "",
              missing.length > 0 ? w.authoredMissing(missing.join(", ")) : "",
            ]
              .filter((x) => x !== "")
              .join(" / "),
          }),
      evidence: { host, ...(doc.how === undefined ? {} : { command: doc.how }) },
    };
  }
  return { status: "not_run", reason: w.awsNotCollected() };
}

// Bound by a project, because the id is a project's own.
export function registerAwsRdsChannel(binding: { sheet?: string; parameters_authored?: string }): void {
  const id = binding.parameters_authored;
  if (id === undefined) return;
  registerFunctionalChannel({
    name: "aws-rds",
    covers: (x) => x === id,
    answer: (_x, hosts, _instance, ctx) => authoredAnswer(hosts, ctx?.items ?? [], binding.sheet ?? "", wordsFor(ctx?.lang)),
  });
}
