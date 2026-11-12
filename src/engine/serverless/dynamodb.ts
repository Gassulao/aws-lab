// Amazon DynamoDB básico: tablas, putItem/getItem/deleteItem/updateItem, query y scan con expresiones
// (condición, filtro, clave, proyección y actualización), índices secundarios globales y estados de la tabla.
import { AwsError } from '../errors';
import { trailed, type Ctx } from '../api';
import type { CloudState } from '../types';
import { hex, guid, now } from '../util';
import { speedFactor } from '../store';
import { sv, type DdbTable, type Item, type AttrValue } from './types';
import { svAuthorize, asArr } from './util';

const SRC = 'dynamodb.amazonaws.com';
const tableArn = (ctx: Ctx, n: string) => `arn:aws:dynamodb:${ctx.region}:${ctx.s.account.id}:table/${n}`;
const val = (m: string) => new AwsError('ValidationException', m, 400);
const pv = (m: string) => val('One or more parameter values were invalid: ' + m);

export function tableStatus(t: DdbTable): 'CREATING' | 'ACTIVE' { return now() >= t.readyAt ? 'ACTIVE' : 'CREATING'; }
export function getTable(ctx: Ctx, name: string, needActive = true): DdbTable {
  const t = sv(ctx.s).tables.find((x) => x.name === name && x.region === ctx.region);
  if (!t) throw new AwsError('ResourceNotFoundException', needActive ? 'Requested resource not found' : 'Cannot do operations on a non-existent table', 400);
  if (needActive && tableStatus(t) !== 'ACTIVE') throw new AwsError('ResourceNotFoundException', 'Requested resource not found', 400);
  return t;
}

// ------------------------------------------------------------------ valores
const typeOf = (a: AttrValue) => Object.keys(a)[0];
const numOf = (a: AttrValue) => Number(a.N);
const same = (a: AttrValue | undefined, b: AttrValue | undefined) => !!a && !!b && typeOf(a) === typeOf(b) && (a.N !== undefined ? numOf(a) === numOf(b) : JSON.stringify(a) === JSON.stringify(b));
function compare(a: AttrValue, b: AttrValue): number {
  if (typeOf(a) !== typeOf(b)) return NaN;
  if (a.N !== undefined) return numOf(a) - numOf(b);
  const x = String(a.S ?? a.B), y = String(b.S ?? b.B);
  return x < y ? -1 : x > y ? 1 : 0;
}
function checkAttrValue(a: any) {
  if (!a || typeof a !== 'object' || Object.keys(a).length !== 1 || !['S', 'N', 'B', 'BOOL', 'NULL', 'L', 'M', 'SS', 'NS', 'BS'].includes(Object.keys(a)[0])) throw val('Supplied AttributeValue is empty, must contain exactly one of the supported datatypes');
  if (a.N !== undefined && (typeof a.N !== 'string' || !Number.isFinite(Number(a.N)))) throw val(`The parameter cannot be converted to a numeric value: ${a.N}`);
}

// ------------------------------------------------------------------ expresiones
interface Ex { names: Record<string, string>; values: Record<string, AttrValue> }
type Tk = { k: 'id' | 'name' | 'val' | 'num' | 'op' | 'eof'; v: string };
function lex(src: string): Tk[] {
  const out: Tk[] = [];
  const re = /\s*(?:(#[A-Za-z0-9_]+)|(:[A-Za-z0-9_]+)|([A-Za-z_][A-Za-z0-9_]*)|(\d+)|(<>|<=|>=|=|<|>|\(|\)|,|\.|\[|\]|\+|-))/y;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1]) out.push({ k: 'name', v: m[1] }); else if (m[2]) out.push({ k: 'val', v: m[2] }); else if (m[3]) out.push({ k: 'id', v: m[3] }); else if (m[4]) out.push({ k: 'num', v: m[4] }); else out.push({ k: 'op', v: m[5] });
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
  }
  if (src.trim() && !out.length) throw val(`Invalid expression: Syntax error; token: "${src.trim().split(/\s/)[0]}", near: "${src.trim()}"`);
  out.push({ k: 'eof', v: '' });
  return out;
}

class Parser {
  i = 0; toks: Tk[];
  constructor(public src: string, public ex: Ex, public kind: string, public used: Set<string>) { this.toks = lex(src); }
  get t() { return this.toks[this.i]; }
  err(): never { throw val(`Invalid ${this.kind}: Syntax error; token: "${this.t.v}", near: "${this.src.slice(Math.max(0, this.src.indexOf(this.t.v)), this.src.indexOf(this.t.v) + 12)}"`); }
  kw(w: string) { return this.t.k === 'id' && this.t.v.toUpperCase() === w; }
  eatKw(w: string) { if (this.kw(w)) { this.i++; return true; } return false; }
  eatOp(o: string) { if (this.t.k === 'op' && this.t.v === o) { this.i++; return true; } return false; }
  expectOp(o: string) { if (!this.eatOp(o)) this.err(); }
  /** Condición → función de evaluación sobre un item. */
  cond(): (it: Item) => boolean {
    let l = this.and();
    while (this.eatKw('OR')) { const a = l, b = this.and(); l = (it) => a(it) || b(it); }
    return l;
  }
  and(): (it: Item) => boolean {
    let l = this.not();
    while (this.eatKw('AND')) { const a = l, b = this.not(); l = (it) => a(it) && b(it); }
    return l;
  }
  not(): (it: Item) => boolean {
    if (this.eatKw('NOT')) { const c = this.not(); return (it) => !c(it); }
    if (this.eatOp('(')) { const c = this.cond(); this.expectOp(')'); return c; }
    if (this.t.k === 'id' && this.toks[this.i + 1]?.v === '(' && ['attribute_exists', 'attribute_not_exists', 'begins_with', 'contains', 'attribute_type'].includes(this.t.v)) {
      const fn = this.t.v; this.i += 2;
      const a = this.operand(); let b: ((it: Item) => AttrValue | undefined) | null = null;
      if (this.eatOp(',')) b = this.operand();
      this.expectOp(')');
      return (it) => {
        const x = a(it), y = b?.(it);
        switch (fn) {
          case 'attribute_exists': return x !== undefined;
          case 'attribute_not_exists': return x === undefined;
          case 'begins_with': return !!x && !!y && x.S !== undefined && x.S.startsWith(String(y.S));
          case 'contains': return !!x && !!y && (x.S !== undefined ? x.S.includes(String(y.S)) : (x.SS ?? x.L ?? []).some((e: any) => same(e.S !== undefined || e.N !== undefined ? e : { S: e }, y) || e === y.S));
          default: return !!x && typeOf(x) === y?.S;
        }
      };
    }
    const a = this.operand();
    if (this.eatKw('BETWEEN')) { const lo = this.operand(); if (!this.eatKw('AND')) this.err(); const hi = this.operand(); return (it) => { const x = a(it), l = lo(it), h = hi(it); return !!x && !!l && !!h && compare(x, l) >= 0 && compare(x, h) <= 0; }; }
    if (this.eatKw('IN')) { this.expectOp('('); const list = [this.operand()]; while (this.eatOp(',')) list.push(this.operand()); this.expectOp(')'); return (it) => list.some((o) => same(a(it), o(it))); }
    const op = this.t.k === 'op' ? this.t.v : '';
    if (!['=', '<>', '<', '<=', '>', '>='].includes(op)) this.err();
    this.i++;
    const b = this.operand();
    return (it) => {
      const x = a(it), y = b(it);
      if (op === '=') return same(x, y);
      if (op === '<>') return !same(x, y);
      if (!x || !y) return false;
      const c = compare(x, y);
      return Number.isNaN(c) ? false : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    };
  }
  path(): string[] {
    const parts: string[] = [];
    const seg = () => {
      if (this.t.k === 'name') { const r = this.ex.names[this.t.v]; this.used.add(this.t.v); if (r === undefined) throw val(`Invalid ${this.kind}: An expression attribute name used in the document path is not defined; attribute name: ${this.t.v}`); parts.push(r); this.i++; }
      else if (this.t.k === 'id') { parts.push(this.t.v); this.i++; } else this.err();
    };
    seg();
    while (this.t.k === 'op' && (this.t.v === '.' || this.t.v === '[')) {
      if (this.eatOp('.')) seg(); else { this.i++; parts.push('[' + this.t.v + ']'); this.i++; this.expectOp(']'); }
    }
    return parts;
  }
  operand(): (it: Item) => AttrValue | undefined {
    if (this.t.k === 'val') {
      const n = this.t.v; this.used.add(n); this.i++;
      const v = this.ex.values[n];
      if (v === undefined) throw val(`Invalid ${this.kind}: An expression attribute value used in expression is not defined; attribute value: ${n}`);
      return () => v;
    }
    if (this.t.k === 'id' && this.t.v === 'size' && this.toks[this.i + 1]?.v === '(') {
      this.i += 2; const p = this.operand(); this.expectOp(')');
      return (it) => { const x = p(it); if (!x) return undefined; return { N: String(x.S !== undefined ? x.S.length : (x.L ?? x.SS ?? x.NS ?? Object.keys(x.M ?? {})).length) }; };
    }
    const p = this.path();
    return (it) => getPath(it, p);
  }
}
function getPath(it: Item, p: string[]): AttrValue | undefined {
  let cur: any = { M: it };
  for (const seg of p) {
    if (!cur) return undefined;
    if (seg.startsWith('[')) cur = cur.L?.[Number(seg.slice(1, -1))]; else cur = cur.M?.[seg];
  }
  return cur;
}
function setPath(it: Item, p: string[], v: AttrValue) {
  let cur: any = { M: it };
  for (let i = 0; i < p.length - 1; i++) { const nx = p[i].startsWith('[') ? cur.L?.[Number(p[i].slice(1, -1))] : cur.M?.[p[i]]; if (!nx) throw val('The document path provided in the update expression is invalid for update'); cur = nx; }
  const last = p[p.length - 1];
  if (last.startsWith('[')) (cur.L ??= [])[Number(last.slice(1, -1))] = v; else (cur.M ??= {})[last] = v;
}
function removePath(it: Item, p: string[]) {
  const par = p.length > 1 ? getPath(it, p.slice(0, -1)) : { M: it };
  const last = p[p.length - 1];
  if (!par) return;
  if (last.startsWith('[')) par.L?.splice(Number(last.slice(1, -1)), 1); else if (par.M) delete par.M[last];
}

function exOf(p: { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttrValue> }): Ex {
  const values = p.ExpressionAttributeValues ?? {};
  for (const v of Object.values(values)) checkAttrValue(v);
  return { names: p.ExpressionAttributeNames ?? {}, values };
}
function unusedCheck(ex: Ex, used: Set<string>) {
  const un = [...Object.keys(ex.names), ...Object.keys(ex.values)].filter((k) => !used.has(k));
  if (un.length) throw val(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${un.join(', ')}}`.replace('ExpressionAttributeNames', un[0].startsWith('#') ? 'ExpressionAttributeNames' : 'ExpressionAttributeValues'));
}
function compileCond(src: string | undefined, ex: Ex, kind: string, used: Set<string>) {
  if (!src) return null;
  const p = new Parser(src, ex, kind, used);
  const c = p.cond();
  if (p.t.k !== 'eof') p.err();
  return c;
}

function applyUpdate(it: Item, src: string, ex: Ex, used: Set<string>) {
  const p = new Parser(src, ex, 'UpdateExpression', used);
  const operandV = (): AttrValue => {
    const exprOperand = (): AttrValue => {
      if (p.t.k === 'id' && p.t.v === 'if_not_exists') { p.i += 2; const path = p.path(); p.expectOp(','); const d = exprOperand(); p.expectOp(')'); return getPath(it, path) ?? d; }
      if (p.t.k === 'id' && p.t.v === 'list_append') { p.i += 2; const a = exprOperand(); p.expectOp(','); const b = exprOperand(); p.expectOp(')'); return { L: [...(a.L ?? []), ...(b.L ?? [])] }; }
      const o = p.operand()(it);
      if (!o) throw val('The provided expression refers to an attribute that does not exist in the item');
      return o;
    };
    let a = exprOperand();
    while (p.t.k === 'op' && (p.t.v === '+' || p.t.v === '-')) {
      const op = p.t.v; p.i++; const b = exprOperand();
      if (a.N === undefined || b.N === undefined) throw val('An operand in the update expression has an incorrect data type');
      a = { N: String(op === '+' ? numOf(a) + numOf(b) : numOf(a) - numOf(b)) };
    }
    return a;
  };
  while (p.t.k !== 'eof') {
    if (p.eatKw('SET')) {
      do { const path = p.path(); p.expectOp('='); setPath(it, path, operandV()); } while (p.eatOp(','));
    } else if (p.eatKw('REMOVE')) {
      do { removePath(it, p.path()); } while (p.eatOp(','));
    } else if (p.eatKw('ADD')) {
      do {
        const path = p.path(); const v = p.operand()(it)!; const cur = getPath(it, path);
        if (v.N !== undefined) setPath(it, path, { N: String((cur ? numOf(cur) : 0) + numOf(v)) });
        else { const key = v.SS ? 'SS' : 'NS'; setPath(it, path, { [key]: [...new Set([...(cur?.[key] ?? []), ...(v[key] ?? [])])] }); }
      } while (p.eatOp(','));
    } else if (p.eatKw('DELETE')) {
      do { const path = p.path(); const v = p.operand()(it)!; const cur = getPath(it, path); const key = v.SS ? 'SS' : 'NS'; if (cur) setPath(it, path, { [key]: (cur[key] ?? []).filter((x: string) => !(v[key] ?? []).includes(x)) }); } while (p.eatOp(','));
    } else p.err();
  }
}

function project(it: Item, proj: string | undefined, ex: Ex, used: Set<string>, legacy?: string[]): Item {
  if (!proj && !legacy) return it;
  const out: Item = {};
  const paths = proj ? proj.split(',').map((x) => { const q = new Parser(x.trim(), ex, 'ProjectionExpression', used); return q.path(); }) : legacy!.map((x) => [x]);
  for (const path of paths) { const v = getPath(it, path); if (v !== undefined) out[path[0]] = path.length === 1 ? v : it[path[0]]; }
  return out;
}

// ------------------------------------------------------------------ tablas
type KeyEl = { AttributeName: string; KeyType: string };
function keyOf(t: DdbTable | { keySchema: KeyEl[] }, it: Item): Item { return Object.fromEntries((t as DdbTable).keySchema.map((k) => [k.AttributeName, it[k.AttributeName]])); }
const keyStr = (t: DdbTable, it: Item) => JSON.stringify(t.keySchema.map((k) => { const a = it[k.AttributeName]; return a?.N !== undefined ? ['N', numOf(a)] : a; }));

function checkKey(t: DdbTable, item: Item, what: 'item' | 'key') {
  for (const k of t.keySchema) {
    const a = item[k.AttributeName];
    if (!a) throw pv(what === 'item' ? `Missing the key ${k.AttributeName} in the item` : 'The provided key element does not match the schema');
    const want = t.attrDefs.find((d) => d.AttributeName === k.AttributeName)?.AttributeType;
    if (typeOf(a) !== want) throw pv(`Type mismatch for key ${k.AttributeName} expected: ${want} actual: ${typeOf(a)}`);
    if (a.S === '') throw pv(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${k.AttributeName}`);
  }
  if (what === 'key' && Object.keys(item).length !== t.keySchema.length) throw pv('The provided key element does not match the schema');
}

export function createTable(ctx: Ctx, p: { TableName: string; KeySchema: KeyEl[]; AttributeDefinitions: { AttributeName: string; AttributeType: string }[]; BillingMode?: string; ProvisionedThroughput?: { ReadCapacityUnits: number; WriteCapacityUnits: number }; GlobalSecondaryIndexes?: any[]; Tags?: { Key: string; Value: string }[] }): DdbTable {
  return trailed(ctx, SRC, 'CreateTable', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName, keySchema: p.KeySchema, billingMode: p.BillingMode }, () => {
    svAuthorize(ctx, 'dynamodb:CreateTable', tableArn(ctx, p.TableName ?? ''));
    const name = p.TableName ?? '';
    if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(name)) throw val(`1 validation error detected: Value '${name}' at 'tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+`);
    const ks = asArr(p.KeySchema), ad = asArr(p.AttributeDefinitions);
    if (!ks.length) throw val("1 validation error detected: Value null at 'keySchema' failed to satisfy constraint: Member must not be null");
    if (ks.length > 2 || ks[0].KeyType !== 'HASH' || (ks[1] && ks[1].KeyType !== 'RANGE')) throw pv('Invalid KeySchema: The first KeySchemaElement is not a HASH key type');
    const gsis = asArr(p.GlobalSecondaryIndexes);
    const keyNames = new Set([...ks.map((k) => k.AttributeName), ...gsis.flatMap((g) => asArr<KeyEl>(g.KeySchema).map((k) => k.AttributeName))]);
    const missing = [...keyNames].filter((k) => !ad.some((d) => d.AttributeName === k));
    if (missing.length) throw pv(`Some index key attributes are not defined in AttributeDefinitions. Keys: [${missing.join(', ')}], AttributeDefinitions: [${ad.map((d) => d.AttributeName).join(', ')}]`);
    const extra = ad.filter((d) => !keyNames.has(d.AttributeName));
    if (extra.length) throw pv(`Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions`);
    for (const d of ad) if (!['S', 'N', 'B'].includes(d.AttributeType)) throw val(`1 validation error detected: Value '${d.AttributeType}' at 'attributeDefinitions.1.member.attributeType' failed to satisfy constraint: Member must satisfy enum value set: [B, N, S]`);
    const mode = (p.BillingMode ?? (p.ProvisionedThroughput ? 'PROVISIONED' : undefined)) as DdbTable['billingMode'] | undefined;
    if (!mode) throw pv('No provisioned throughput specified for the table. Provide ProvisionedThroughput or set BillingMode to PAY_PER_REQUEST.'.replace('No provisioned throughput specified for the table. Provide ProvisionedThroughput or set BillingMode to PAY_PER_REQUEST.', 'ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED'));
    if (mode === 'PROVISIONED' && !p.ProvisionedThroughput) throw pv('ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED');
    if (mode === 'PAY_PER_REQUEST' && p.ProvisionedThroughput) throw pv('Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST');
    if (sv(ctx.s).tables.some((x) => x.name === name && x.region === ctx.region)) throw new AwsError('ResourceInUseException', `Table already exists: ${name}`, 400);
    const t: DdbTable = {
      name, arn: tableArn(ctx, name), region: ctx.region, keySchema: ks as DdbTable['keySchema'], attrDefs: ad, billingMode: mode, rcu: Number(p.ProvisionedThroughput?.ReadCapacityUnits ?? 0), wcu: Number(p.ProvisionedThroughput?.WriteCapacityUnits ?? 0),
      createdAt: now(), readyAt: now() + Math.round(3000 * speedFactor()), items: [], gsis: gsis.map((g) => ({ IndexName: g.IndexName, KeySchema: g.KeySchema, Projection: g.Projection ?? { ProjectionType: 'ALL' } })), tableId: guid(),
      tags: Object.fromEntries(asArr(p.Tags).map((x) => [x.Key, x.Value])),
    };
    sv(ctx.s).tables.push(t);
    return t;
  });
}
export function describeTable(ctx: Ctx, p: { TableName: string }): DdbTable {
  return trailed(ctx, SRC, 'DescribeTable', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName }, () => {
    svAuthorize(ctx, 'dynamodb:DescribeTable', tableArn(ctx, p.TableName));
    return getTable(ctx, p.TableName, false);
  });
}
export function listTables(ctx: Ctx): DdbTable[] {
  return trailed(ctx, SRC, 'ListTables', [], {}, () => {
    svAuthorize(ctx, 'dynamodb:ListTables', `arn:aws:dynamodb:${ctx.region}:${ctx.s.account.id}:table/*`);
    return sv(ctx.s).tables.filter((t) => t.region === ctx.region);
  });
}
export function deleteTable(ctx: Ctx, p: { TableName: string }): DdbTable {
  return trailed(ctx, SRC, 'DeleteTable', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName }, () => {
    svAuthorize(ctx, 'dynamodb:DeleteTable', tableArn(ctx, p.TableName));
    const t = getTable(ctx, p.TableName, false);
    sv(ctx.s).tables = sv(ctx.s).tables.filter((x) => x !== t);
    return t;
  });
}

// ------------------------------------------------------------------ elementos
function conditional(t: DdbTable, existing: Item | undefined, p: { ConditionExpression?: string; ExpressionAttributeNames?: any; ExpressionAttributeValues?: any }, used: Set<string>, ex: Ex) {
  const c = compileCond(p.ConditionExpression, ex, 'ConditionExpression', used);
  if (c && !c(existing ?? {})) throw new AwsError('ConditionalCheckFailedException', 'The conditional request failed', 400);
  void t;
}
function itemsEqualKey(t: DdbTable, key: Item) { const ks = keyStr(t, key); return (x: Item) => keyStr(t, x) === ks; }

export function putItem(ctx: Ctx, p: { TableName: string; Item: Item; ReturnValues?: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttrValue> }) {
  return trailed(ctx, SRC, 'PutItem', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName }, () => {
    svAuthorize(ctx, 'dynamodb:PutItem', tableArn(ctx, p.TableName));
    const t = getTable(ctx, p.TableName);
    const it = p.Item ?? {};
    for (const v of Object.values(it)) checkAttrValue(v);
    checkKey(t, it, 'item');
    const ex = exOf(p); const used = new Set<string>();
    const old = t.items.find(itemsEqualKey(t, it));
    conditional(t, old, p, used, ex);
    unusedCheck(ex, used);
    t.items = t.items.filter((x) => x !== old);
    t.items.push(JSON.parse(JSON.stringify(it)));
    return p.ReturnValues === 'ALL_OLD' && old ? { Attributes: old } : {};
  });
}
export function getItem(ctx: Ctx, p: { TableName: string; Key: Item; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string>; AttributesToGet?: string[] }) {
  return trailed(ctx, SRC, 'GetItem', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName, key: p.Key }, () => {
    svAuthorize(ctx, 'dynamodb:GetItem', tableArn(ctx, p.TableName));
    const t = getTable(ctx, p.TableName);
    for (const v of Object.values(p.Key ?? {})) checkAttrValue(v);
    checkKey(t, p.Key ?? {}, 'key');
    const it = t.items.find(itemsEqualKey(t, p.Key));
    const ex = exOf(p); const used = new Set<string>();
    return it ? { Item: project(it, p.ProjectionExpression, ex, used, p.AttributesToGet) } : {};
  });
}
export function deleteItem(ctx: Ctx, p: { TableName: string; Key: Item; ReturnValues?: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttrValue> }) {
  return trailed(ctx, SRC, 'DeleteItem', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName, key: p.Key }, () => {
    svAuthorize(ctx, 'dynamodb:DeleteItem', tableArn(ctx, p.TableName));
    const t = getTable(ctx, p.TableName);
    checkKey(t, p.Key ?? {}, 'key');
    const ex = exOf(p); const used = new Set<string>();
    const old = t.items.find(itemsEqualKey(t, p.Key));
    conditional(t, old, p, used, ex);
    unusedCheck(ex, used);
    if (old) t.items = t.items.filter((x) => x !== old);
    return p.ReturnValues === 'ALL_OLD' && old ? { Attributes: old } : {};
  });
}
export function updateItem(ctx: Ctx, p: { TableName: string; Key: Item; UpdateExpression?: string; ReturnValues?: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttrValue> }) {
  return trailed(ctx, SRC, 'UpdateItem', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName, key: p.Key }, () => {
    svAuthorize(ctx, 'dynamodb:UpdateItem', tableArn(ctx, p.TableName));
    const t = getTable(ctx, p.TableName);
    checkKey(t, p.Key ?? {}, 'key');
    const ex = exOf(p); const used = new Set<string>();
    const old = t.items.find(itemsEqualKey(t, p.Key));
    conditional(t, old, p, used, ex);
    const next: Item = old ? JSON.parse(JSON.stringify(old)) : { ...JSON.parse(JSON.stringify(p.Key)) };
    if (p.UpdateExpression) applyUpdate(next, p.UpdateExpression, ex, used);
    unusedCheck(ex, used);
    for (const k of t.keySchema) if (!same(next[k.AttributeName], p.Key[k.AttributeName])) throw pv(`Cannot update attribute ${k.AttributeName}. This attribute is part of the key`);
    if (old) t.items = t.items.filter((x) => x !== old);
    t.items.push(next);
    const rv = p.ReturnValues;
    return rv === 'ALL_NEW' ? { Attributes: next } : rv === 'ALL_OLD' && old ? { Attributes: old } : {};
  });
}

type QueryP = { TableName: string; IndexName?: string; KeyConditionExpression?: string; FilterExpression?: string; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttrValue>; Limit?: number; ScanIndexForward?: boolean; Select?: string; ExclusiveStartKey?: Item };

function run(ctx: Ctx, p: QueryP, isQuery: boolean) {
  const t = getTable(ctx, p.TableName);
  const idx = p.IndexName ? t.gsis.find((g) => g.IndexName === p.IndexName) : undefined;
  if (p.IndexName && !idx) throw val(`The table does not have the specified index: ${p.IndexName}`);
  const schema = (idx ? idx.KeySchema : t.keySchema) as KeyEl[];
  const ex = exOf(p); const used = new Set<string>();
  let items = [...t.items];
  if (isQuery) {
    if (!p.KeyConditionExpression) throw val('Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.');
    const kc = compileCond(p.KeyConditionExpression, ex, 'KeyConditionExpression', used)!;
    const pk = schema[0].AttributeName;
    // La condición debe fijar la clave de partición por igualdad.
    const m = new RegExp(`(?:^|\\s|\\()(?:#\\w+|${pk})\\s*=\\s*(:\\w+)`).exec(p.KeyConditionExpression);
    const named = Object.entries(ex.names).filter(([, v]) => v === pk).map(([k]) => k);
    const hasPk = (new RegExp(`(^|[\\s(])${pk}\\s*=\\s*:\\w+`).test(p.KeyConditionExpression)) || named.some((n) => new RegExp(`${n}\\s*=\\s*:\\w+`).test(p.KeyConditionExpression!));
    if (!hasPk) throw val(`Query condition missed key schema element: ${pk}`);
    void m;
    items = items.filter((it) => !!it[pk] && kc(it));
    const sk = schema[1]?.AttributeName;
    if (sk) items.sort((a, b) => { const c = a[sk] && b[sk] ? compare(a[sk], b[sk]) : 0; return Number.isNaN(c) ? 0 : c; });
    if (p.ScanIndexForward === false) items.reverse();
  } else if (idx) items = items.filter((it) => schema.every((k) => it[k.AttributeName]));
  let startIdx = 0;
  if (p.ExclusiveStartKey) { const esk = p.ExclusiveStartKey; const i = items.findIndex((it) => Object.entries(esk).every(([k, v]) => same(it[k], v))); if (i >= 0) startIdx = i + 1; }
  items = items.slice(startIdx);
  const limit = p.Limit !== undefined ? Number(p.Limit) : undefined;
  if (limit !== undefined && limit < 1) throw val(`1 validation error detected: Value '${limit}' at 'limit' failed to satisfy constraint: Member must have value greater than or equal to 1`);
  const page = limit !== undefined ? items.slice(0, limit) : items;
  const filter = compileCond(p.FilterExpression, ex, 'FilterExpression', used);
  const kept = filter ? page.filter((it) => filter(it)) : page;
  const out = p.Select === 'COUNT' ? [] : kept.map((it) => project(it, p.ProjectionExpression, ex, used));
  unusedCheck(ex, used);
  const res: any = { Items: out, Count: kept.length, ScannedCount: page.length };
  if (p.Select === 'COUNT') delete res.Items;
  if (limit !== undefined && items.length > limit && page.length) res.LastEvaluatedKey = { ...keyOf(t, page[page.length - 1]), ...(idx ? Object.fromEntries(schema.map((k) => [k.AttributeName, page[page.length - 1][k.AttributeName]])) : {}) };
  return res;
}
export function query(ctx: Ctx, p: QueryP) {
  return trailed(ctx, SRC, 'Query', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName, keyConditionExpression: p.KeyConditionExpression }, () => {
    svAuthorize(ctx, 'dynamodb:Query', tableArn(ctx, p.TableName) + (p.IndexName ? `/index/${p.IndexName}` : ''));
    return run(ctx, p, true);
  });
}
export function scan(ctx: Ctx, p: QueryP) {
  return trailed(ctx, SRC, 'Scan', [{ type: 'AWS::DynamoDB::Table', name: p.TableName }], { tableName: p.TableName }, () => {
    svAuthorize(ctx, 'dynamodb:Scan', tableArn(ctx, p.TableName) + (p.IndexName ? `/index/${p.IndexName}` : ''));
    return run(ctx, p, false);
  });
}
export function batchWriteItem(ctx: Ctx, p: { RequestItems: Record<string, { PutRequest?: { Item: Item }; DeleteRequest?: { Key: Item } }[]> }) {
  return trailed(ctx, SRC, 'BatchWriteItem', [], {}, () => {
    for (const [name, reqs] of Object.entries(p.RequestItems ?? {})) {
      svAuthorize(ctx, 'dynamodb:BatchWriteItem', tableArn(ctx, name));
      const t = getTable(ctx, name);
      for (const r of asArr(reqs)) {
        if (r.PutRequest) { checkKey(t, r.PutRequest.Item, 'item'); t.items = t.items.filter((x) => !itemsEqualKey(t, r.PutRequest!.Item)(x)); t.items.push(JSON.parse(JSON.stringify(r.PutRequest.Item))); }
        else if (r.DeleteRequest) { checkKey(t, r.DeleteRequest.Key, 'key'); t.items = t.items.filter((x) => !itemsEqualKey(t, r.DeleteRequest!.Key)(x)); }
      }
    }
    return { UnprocessedItems: {} };
  });
}
export function tagResource(ctx: Ctx, p: { ResourceArn: string; Tags: { Key: string; Value: string }[] }) {
  return trailed(ctx, SRC, 'TagResource', [], p, () => { const t = sv(ctx.s).tables.find((x) => x.arn === p.ResourceArn); if (!t) throw new AwsError('ResourceNotFoundException', `Requested resource not found: ResourcArn: ${p.ResourceArn} not found`, 400); for (const x of asArr(p.Tags)) t.tags[x.Key] = x.Value; });
}
export function listTags(ctx: Ctx, p: { ResourceArn: string }) {
  return trailed(ctx, SRC, 'ListTagsOfResource', [], p, () => { const t = sv(ctx.s).tables.find((x) => x.arn === p.ResourceArn); if (!t) throw new AwsError('ResourceNotFoundException', `Requested resource not found: ResourcArn: ${p.ResourceArn} not found`, 400); return t.tags; });
}
void hex;
export type { CloudState };
