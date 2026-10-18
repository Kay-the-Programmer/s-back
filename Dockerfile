# Build stage
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Copy source code
COPY . .

# Install all dependencies (including devDependencies for building)
RUN npm install

# Build the TypeScript code
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev --ignore-scripts

# Copy compiled code from builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Create necessary directories for the application. `archives` must exist in
# the image: store deletion writes a full archive before destroying anything,
# and on a host where ./archives was never created the bind mount lands broken
# and even a recursive mkdir fails — every deletion then 500s.
RUN mkdir -p uploads public/images archives

# Expose the application port
EXPOSE 5000

# Start the application
CMD ["npm", "start"]
