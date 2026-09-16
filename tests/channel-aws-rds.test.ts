// A PRODUCT plugin that says only WHERE a row sits in what an API returned.
//
// The relation between the address a Terraform plan gives a row and the field
// the RDS API answers it with is AWS's and the provider's — the same in every
// project that reviews an RDS cluster — and it cannot be inferred from the
// spelling, which is the whole reason it is a table rather than a rule.

import { CHANNEL_WORDS } from "../src/channel-words";
import { describe, it, expect, beforeEach } from "bun:test";
import "../src/parsers/index";
import { awsRdsRouter, registerAwsRdsRouter, registerAwsRdsChannel } from "../src/channels/aws-rds";
import { listDocumentRouters, listFunctionalChannels } from "../src/channel";
import { judgeFiles, type Observation } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

const clear = (): void => {
  for (const key of ["review-sheet.document-routers.v1", "review-sheet.functional-channels.v1"]) {
    const arr = (globalThis as Record<symbol, unknown>)[Symbol.for(key)] as unknown[];
    if (Array.isArray(arr)) arr.length = 0;
  }
};
beforeEach(clear);

const route = (key: string) => awsRdsRouter.route({ target: { sheet: "s", key, instance: "staging" } } as TestItem);

describe("where an RDS row sits in the API's reply", () => {
  it("routes a parameter of a group to the list the API identifies by name", () => {
    expect(route("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].value")).toEqual({
      document: "describe-db-cluster-parameters",
      address: "Parameters[ParameterName=max_connections].ParameterValue",
      idFields: ["ParameterName"],
    });
    expect(route("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].apply_method")?.address).toBe(
      "Parameters[ParameterName=max_connections].ApplyMethod"
    );
  });

  // The API's own spelling, which no rule produces: `name` is
  // `DBClusterParameterGroupName` and `family` is `DBParameterGroupFamily` —
  // one carries the "Cluster", the other does not.
  it("routes a group's own attributes to the names the API gives them", () => {
    expect(route("aurora.aws_rds_cluster_parameter_group.this.name")?.address).toBe(
      "DBClusterParameterGroups[0].DBClusterParameterGroupName"
    );
    expect(route("aurora.aws_rds_cluster_parameter_group.this.family")?.address).toBe(
      "DBClusterParameterGroups[0].DBParameterGroupFamily"
    );
    expect(route("aurora.aws_rds_cluster.this.db_cluster_parameter_group_name")?.address).toBe(
      "DBClusters[0].DBClusterParameterGroup"
    );
  });

  // Which module a resource sits in and what the project called it are the
  // project's, so the table is matched on the TYPE and the argument only.
  it("does not care which module the resource is in or what it is called", () => {
    expect(route("db.aws_rds_cluster_parameter_group.main.name")?.document).toBe("describe-db-cluster-parameter-groups");
  });

  // A row the table does not name gets no answer at all. Guessing is what this
  // exists instead of: `db_cluster_parameter_group_name` is
  // `DBClusterParameterGroup`, so a plausible rule is a wrong answer in silence.
  it("says nothing about an argument or a resource type it has no entry for", () => {
    expect(route("aurora.aws_rds_cluster_parameter_group.this.tags")).toBeUndefined();
    expect(route("aurora.aws_rds_cluster.this.backup_retention_period")).toBeUndefined();
    expect(route("aurora.aws_lb.this.internal")).toBeUndefined();
  });
});

// …and the half that makes it useful: the tool reads the reply with the same
// machinery it reads a file with, once the router has said where to look.
const PARAMETERS = JSON.stringify(
  {
    Parameters: [
      { ParameterName: "client_encoding", ParameterValue: "UTF8", ApplyMethod: "immediate", Source: "user" },
      { ParameterName: "max_connections", ParameterValue: "500", ApplyMethod: "pending-reboot", Source: "user" },
    ],
  },
  null,
  2
);

const item = (key: string, expected: string): TestItem =>
  ({ target: { sheet: "aws infrastructure", key, instance: "staging" }, unit: "u", kind: "value", decider: "project", expected }) as TestItem;

const planOf = (items: TestItem[]): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: ["aws infrastructure"] }], items, functional: [] }) as TestPlan;

const obs: Observation = {
  environment: "staging",
  collected_at: "2026-09-11T00:00:00Z",
  hosts: {
    "123456789012 / ap-northeast-1": {
      files: {},
      documents: [
        { name: "describe-db-cluster-parameters", format: "json", how: "aws rds describe-db-cluster-parameters …", text: PARAMETERS },
      ],
    },
  },
};

const judge = (items: TestItem[]) =>
  judgeFiles(planOf(items), [obs], { at: "X", lang: "en", documents: [{ sheet: "aws infrastructure", router: "aws-rds" }] });

describe("a row answered through a router", () => {
  beforeEach(registerAwsRdsRouter);

  it("is read at the routed address, and points at the line it was read from", () => {
    const got = judge([item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].value", "500")]);
    expect(got.results[0].status).toBe("pass");
    expect(got.results[0].evidence?.host).toBe("123456789012 / ap-northeast-1");
    expect(got.results[0].evidence?.line).toBeGreaterThan(0);
  });

  it("fails one the resource holds differently, with what it holds", () => {
    const got = judge([item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].apply_method", "immediate")]);
    expect(got.results[0].status).toBe("fail");
    expect(got.results[0].actual).toBe("pending-reboot");
  });

  // A row the router does not name is handed BACK, not answered: what to say
  // about a row this step does not check is the project's statement, not the
  // tool's guess.
  it("hands back a row the table has no entry for", () => {
    const got = judge([item("aurora.aws_rds_cluster.this.backup_retention_period", "7")]);
    expect(got.results).toEqual([]);
    expect(got.unanswered.map((i) => i.target.key)).toEqual(["aurora.aws_rds_cluster.this.backup_retention_period"]);
  });

  // The registration is the project's: a router nobody bound answers nothing.
  // And a `documents:` entry naming one nothing registered is a BROKEN
  // DECLARATION, not a router declining a row — the two used to be the same
  // outcome, every row of the sheet unanswered, so a misspelled name or a
  // plugin file that never loaded read as a sheet that has no document.
  it("is only registered when a documents: entry names it", () => {
    clear();
    expect(listDocumentRouters()).toEqual([]);
    expect(() => judge([item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].value", "500")]))
      .toThrow(/names 1 router\(s\) nothing registered/);
  });

  // …and it says what IS registered, because the usual cause of one name being
  // absent is the spelling of another.
  it("names the routers that are registered beside the one that is not", () => {
    registerAwsRdsRouter();
    const wrong = () =>
      judgeFiles(planOf([item("aurora.aws_rds_cluster.this.backup_retention_period", "7")]), [obs], {
        at: "X",
        lang: "en",
        documents: [{ sheet: "aws infrastructure", router: "aws-rd" }],
      });
    expect(wrong).toThrow(/"aws-rd" \(sheet "aws infrastructure"\)/);
    expect(wrong).toThrow(/Registered: "aws-rds"/);
  });
});

// What a row comparison cannot say, even in principle: the sheet names the
// parameters a design decided, the group holds several hundred, and somebody
// changing a different one from the console appears in none of the rows.
describe("nobody changed anything the design did not decide", () => {
  const reply = (params: { ParameterName: string; Source: string }[]) =>
    JSON.stringify({ Parameters: params }, null, 2);
  const hostsWith = (text: string) => ({
    "acct / region": { documents: [{ name: "describe-db-cluster-parameters", how: "aws rds describe-db-cluster-parameters", text }] },
  });
  const plan = [
    item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].value", "500"),
    item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].apply_method", "immediate"),
    item("aurora.aws_rds_cluster.this.db_cluster_parameter_group_name", "g"),
  ];
  const ask = (text: string) => {
    clear();
    registerAwsRdsChannel({ sheet: "aws infrastructure", parameters_authored: "aws-parameters-authored" });
    return listFunctionalChannels()[0]!.answer("aws-parameters-authored", hostsWith(text), "staging", { items: plan })!;
  };

  it("passes when the set the API says a user authored is the set the sheet authors", () => {
    const got = ask(reply([
      { ParameterName: "max_connections", Source: "user" },
      { ParameterName: "work_mem", Source: "engine-default" },
    ]));
    expect(got.status).toBe("pass");
    expect(got.detail).toContain(CHANNEL_WORDS.en.authoredDetail(2, 1));
  });

  // `user` is the API saying somebody set it — which is the whole reason to ask.
  it("fails a change the design does not name, and a design the group does not have", () => {
    expect(ask(reply([
      { ParameterName: "max_connections", Source: "user" },
      { ParameterName: "work_mem", Source: "user" },
    ])).reason).toContain(CHANNEL_WORDS.en.authoredExtra("work_mem"));
    expect(ask(reply([{ ParameterName: "max_connections", Source: "engine-default" }])).reason).toContain(
      CHANNEL_WORDS.en.authoredMissing("max_connections")
    );
  });

  // `apply_method` says HOW a change takes effect, not that the value was
  // changed — so a sheet naming only that has not authored the parameter.
  it("reads the set from the value rows, not from every row naming a parameter", () => {
    clear();
    registerAwsRdsChannel({ sheet: "aws infrastructure", parameters_authored: "aws-parameters-authored" });
    const got = listFunctionalChannels()[0]!.answer(
      "aws-parameters-authored",
      hostsWith(reply([{ ParameterName: "work_mem", Source: "engine-default" }])),
      "staging",
      { items: [item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=work_mem].apply_method", "immediate")] }
    )!;
    expect(got.status).toBe("pass");
  });

  // A page is not the list: the API paginates, a group holds several hundred
  // parameters, and "is there anything here we did not decide" cannot be
  // answered from the first hundred.
  it("refuses a reply the API says is truncated", () => {
    clear();
    registerAwsRdsChannel({ sheet: "aws infrastructure", parameters_authored: "aws-parameters-authored" });
    const truncated = JSON.stringify({ Parameters: [{ ParameterName: "max_connections", Source: "user" }], Marker: "abc" });
    const got = listFunctionalChannels()[0]!.answer("aws-parameters-authored", hostsWith(truncated), "staging", { items: plan })!;
    expect(got.status).toBe("not_run");
    expect(got.reason).toBe(CHANNEL_WORDS.en.parametersPaginated());
    // …and an empty marker is not truncation.
    const whole = JSON.stringify({ Parameters: [{ ParameterName: "max_connections", Source: "user" }], Marker: "" });
    clear();
    registerAwsRdsChannel({ sheet: "aws infrastructure", parameters_authored: "aws-parameters-authored" });
    expect(listFunctionalChannels()[0]!.answer("aws-parameters-authored", hostsWith(whole), "staging", { items: plan })!.status).toBe("pass");
  });

  it("says nothing rather than guessing when AWS was not collected", () => {
    clear();
    registerAwsRdsChannel({ sheet: "aws infrastructure", parameters_authored: "aws-parameters-authored" });
    expect(listFunctionalChannels()[0]!.answer("aws-parameters-authored", {}, "staging", { items: plan })!.status).toBe("not_run");
  });
});
