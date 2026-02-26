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

# Create necessary directories for the application
RUN mkdir -p uploads public/images

# Expose the application port
EXPOSE 5000

# Start the application
CMD ["npm", "start"]
