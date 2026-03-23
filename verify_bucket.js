const { Storage } = require('@google-cloud/storage');

async function main() {
    try {
        const storage = new Storage({
            projectId: serviceAccount.project_id,
            credentials: {
                client_email: serviceAccount.client_email,
                private_key: serviceAccount.private_key
            }
        });

        console.log('Listing all buckets in project...');
        const [buckets] = await storage.getBuckets();
        
        if (buckets.length === 0) {
            console.log('No buckets found in this project.');
        } else {
            console.log('Found buckets:');
            buckets.forEach(b => console.log(` - ${b.name}`));
        }
    } catch (error) {
        console.error(`ERROR listing buckets: ${error.message}`);
    }
    process.exit(0);
}

main();
