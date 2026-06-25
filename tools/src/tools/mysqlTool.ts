import { McpServer } from "@modelcontextprotocol/server";
import mysql from "mysql2/promise"
import { z } from "zod"

import { mcpTool } from "./base";
import { mcpToolResult } from "../utils";

export function mysqlTool(dbName: string, options: mysql.ConnectionOptions) {
  const mcpName = `mysql_${dbName}`;
  return mcpTool(mcpName, createMysqlMcpServer(dbName, options));
}

function createMysqlMcpServer(dbName: string, options: mysql.ConnectionOptions) {
  const mcp = new McpServer({
    name: `mysql_${dbName}`,
    version: "0.0.1"
  }, {
    capabilities: {
      tasks: {}
    }
  });

  mcp.registerTool("query", {
    inputSchema: z.object({
      sql: z.string(),
      timeoutMs: z.number().min(0).max(60000)
    })
  }, async (input) => {
    type MySqlExecuteResult = {
      fields: string[];
      rows: mysql.QueryResult;
    };
    
    return mcpToolResult<MySqlExecuteResult>(async () => {
      const conn = await mysql.createConnection(options);

      try {
        const [rows, fields] = await conn.execute({
          sql: input.sql,
          rowsAsArray: true,
          timeout: input.timeoutMs
        });

        return {
          fields: fields.map(field => field.name),
          rows
        };
      } finally {
        conn.destroy();
      }
    });
  })

  return mcp;
}
