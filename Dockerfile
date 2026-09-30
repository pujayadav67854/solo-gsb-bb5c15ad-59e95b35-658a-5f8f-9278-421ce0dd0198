# 从空环境完成：依赖安装（含 better-sqlite3 原生编译回退）-> 数据初始化 -> 启动
FROM node:20-bookworm-slim

# better-sqlite3 优先使用预编译二进制；以下构建工具仅在无预编译包时作为回退
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷依赖清单，尽量利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝应用代码
COPY src ./src
COPY public ./public

# 持久化数据目录（SQLite 数据库文件）
RUN mkdir -p /data
ENV DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    SEED=1

EXPOSE 3000

# 容器启动时自动建表并（首次）写入种子数据
CMD ["node", "src/server.js"]
