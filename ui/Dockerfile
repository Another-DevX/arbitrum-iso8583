FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_BACKEND_URL=http://localhost:3100
ARG VITE_BACKEND_WS_URL=ws://localhost:3100
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_BACKEND_WS_URL=$VITE_BACKEND_WS_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN npm install --global serve@14
COPY --from=build /app/dist ./dist
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
