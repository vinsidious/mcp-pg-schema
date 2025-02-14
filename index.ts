#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

const server = new Server(
  {
    name: "example-servers/postgres",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Please provide a database URL as a command-line argument");
  process.exit(1);
}

const databaseUrl = args[0];

const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

const pool = new pg.Pool({
  connectionString: databaseUrl,
});

const SCHEMA_PATH = "schema";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    return {
      resources: result.rows.map((row) => ({
        uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "application/json",
        name: `"${row.table_name}" database schema`,
      })),
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
      [tableName]
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(result.rows, null, 2),
        },
      ],
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "schema",
        description: "Get the schema of a database/schema",
        inputSchema: {
          type: "object",
          properties: {
            schema: { type: "string" },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "schema") {
    const schema = request.params.arguments?.schema as string;
    const query = `
SELECT
    t.table_schema,
    t.table_name,

    -- JSON array of columns with relevant info
    (
      SELECT json_agg(
               json_build_object(
                 'column_name', c.column_name,
                 'data_type', c.data_type,
                 'is_nullable', c.is_nullable,
                 'column_default', c.column_default
               )
             )
      FROM information_schema.columns c
      WHERE c.table_name = t.table_name
        AND c.table_schema = t.table_schema
    ) AS columns,

    -- JSON array of constraints with basic references
    (
      SELECT json_agg(
               json_build_object(
                 'constraint_name', tc.constraint_name,
                 'constraint_type', tc.constraint_type,
                 'columns', (
                   SELECT json_agg(kcu.column_name)
                   FROM information_schema.key_column_usage kcu
                   WHERE kcu.constraint_name = tc.constraint_name
                     AND kcu.table_schema = tc.table_schema
                 ),
                 'foreign_table', ccu.table_name,
                 'foreign_column', ccu.column_name
               )
             )
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
            AND tc.table_schema = ccu.table_schema
      WHERE tc.table_name = t.table_name
        AND tc.table_schema = t.table_schema
    ) AS constraints

FROM information_schema.tables t
WHERE t.table_schema = '${schema}'
ORDER BY t.table_schema, t.table_name;
    `;

    const client = await pool.connect();
    try {
      const result = await client.query(query);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
