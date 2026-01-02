# POS Inventory System - Backend

This is the backend for the POS Inventory System. It provides APIs for managing inventory, sales, and other related functionalities.

## Database Setup

The system uses PostgreSQL as its database. Before running the application, you need to set up the database tables.

### Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

### Installation

1. Clone the repository (if you haven't already)
2. Navigate to the backend directory:
   ```
   cd backend
   ```
3. Install dependencies:
   ```
   npm install
   ```
   or
   ```
   yarn install
   ```

### Database Configuration

Before running the script, make sure your PostgreSQL server is running and you have created a database named `sale_pilot_db`.

You may need to modify the database connection settings in `src/scripts/create-tables.ts` to match your PostgreSQL configuration:

```typescript
const pool = new Pool({
    user: 'postgres',      // Change to your PostgreSQL username
    host: 'localhost',     // Change if your PostgreSQL server is on a different host
    database: 'sale_pilot_db',
    password: 'password',  // Change to your PostgreSQL password
    port: 5432,            // Change if your PostgreSQL server uses a different port
});
```

### Running the Create Tables Script

To create all the necessary database tables, run the following command:

```
npx ts-node src/scripts/create-tables.ts
```

This script will:
1. Connect to your PostgreSQL database
2. Read the SQL statements from the SQL file
3. Execute those statements to create all required tables
4. Log the results to the console

If successful, you should see the message: "All tables have been created successfully!"

### Troubleshooting

If you encounter any errors:

1. Make sure PostgreSQL is running
2. Verify your database connection settings
3. Ensure the database `sale_pilot_db` exists
4. Check that you have the necessary permissions to create tables

## Running the Application

After setting up the database, you can start the backend server with:

```
npm start
```
or
```
yarn start
```

The server will start and listen for requests on the configured port.