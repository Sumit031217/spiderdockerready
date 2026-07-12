# Stage 1: Build the React Application
FROM node:22-alpine AS build

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code and run the Vite build process
COPY . .
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:alpine

# Copy the custom Nginx configuration we just made
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the compiled HTML/JS/CSS files from the build stage into Nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80 (Standard HTTP)
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]