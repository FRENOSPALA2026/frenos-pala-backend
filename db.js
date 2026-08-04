const { Pool } = require('pg');
require('dotenv').config();

// La cadena de conexión NUNCA va escrita aquí. Viene de la variable de entorno
// DATABASE_URL, que se configura:
//   - en local: en el archivo .env (que está en .gitignore, no se sube a GitHub)
//   - en Render: en el panel del servicio -> Environment -> Add Environment Variable
//
// Formato (lo copias de Supabase -> Project Settings -> Database -> Connection string):
//   postgresql://usuario:contraseña@host:6543/postgres

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('❌ Falta la variable de entorno DATABASE_URL.');
    console.error('   En local: créala en el archivo .env');
    console.error('   En Render: agrégala en Environment del servicio');
    process.exit(1);
}

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false } // requerido por Supabase
});

pool.connect()
    .then(client => {
        console.log('✅ Conectado a la base de datos exitosamente');
        client.release();
    })
    .catch(err => console.error('❌ Error conectando a la base de datos:', err.message));

module.exports = pool;
