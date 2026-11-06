import { createHash, createHmac } from "node:crypto";

import { z } from "zod";

import { workCellName } from "../../../packages/contracts/src/work.ts";
import type { WorkKey } from "../../../packages/contracts/src/work.ts";
import { docker, fixture } from "./team-support.ts";

export const cellInventory = async (key: WorkKey) => {
  const cell = workCellName(key);
  const namespace = "cells:v1:11:cerebro-api:TeamAgent";
  const secret = createHash("sha256").update(namespace).digest();
  const first = createHmac("sha256", secret)
    .update(cell)
    .digest()
    .subarray(0, 16);
  const second = createHmac("sha256", secret)
    .update(first)
    .digest()
    .subarray(0, 16);
  const scope = `TeamAgent:${Buffer.concat([first, second]).toString("hex")}`;
  const output = await docker(
    "exec",
    await fixture.container("celld"),
    "node",
    "--input-type=module",
    "-e",
    `
    import {readFile,stat} from 'node:fs/promises';
    import {AwsClient} from 'aws4fetch';
    const scope=process.argv[1];
    let local=false;
    try { local=(await stat('/var/lib/celld/state/'+scope)).isDirectory(); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    const password=(await readFile('/run/cerebro-secrets/minio-password','utf8')).trim();
    const client=new AwsClient({accessKeyId:'cerebro',secretAccessKey:password,service:'s3',region:'us-east-1'});
    const url=new URL('http://minio-runtime:9000/cerebro-runtime');
    url.searchParams.set('list-type','2'); url.searchParams.set('prefix','cells/'+scope+'/'); url.searchParams.set('max-keys','1');
    const response=await client.fetch(url); if(!response.ok) throw new Error('Namespace inventory failed: '+response.status);
    const text=await response.text(); const match=text.match(/<KeyCount>([01])<\\/KeyCount>/);
    if(!match) throw new Error('Invalid namespace listing');
    process.stdout.write(JSON.stringify({scope,local,bucket:match[1]==='1'}));
  `,
    scope
  );
  return {
    cell,
    ...z
      .object({ scope: z.string(), local: z.boolean(), bucket: z.boolean() })
      .parse(JSON.parse(output.stdout)),
  };
};
