// A PRODUCT plugin that says only WHERE a row sits in what an API returned.
//
// The relation between the address a Terraform plan gives a row and the field
// the RDS API answers it with is AWS's and the provider's — the same in every
// project that reviews an RDS cluster — and it cannot be inferred from the
// spelling, which is the whole reason it is a table rather than a rule.

import { describe, it, expect, beforeEach } from "bun:test";
import "../src/parsers/index";
import { awsRdsRouter, registerAwsRdsRouter } from "../src/channels/aws-rds";
import { listDocumentRouters } from "../src/channel";
import { judgeFiles, type Observation } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

const clear = (): void => {
  const arr = (globalThis as Record<symbol, unknown>)[Symbol.for("review-sheet.document-routers.v1")] as unknown[];
  if (Array.isArray(arr)) arr.length = 0;
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
  it("is only registered when a documents: entry names it", () => {
    clear();
    expect(listDocumentRouters()).toEqual([]);
    const got = judge([item("aurora.aws_rds_cluster_parameter_group.this.parameter[name=max_connections].value", "500")]);
    expect(got.results).toEqual([]);
  });
});
