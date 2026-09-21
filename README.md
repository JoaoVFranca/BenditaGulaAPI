# Bendita Gula API — execução local

## Primeira execução

1. Instale o Node.js 22.12 ou superior e o Docker Desktop.
2. Abra o Docker Desktop e aguarde sua inicialização.
3. Abra um terminal na pasta do backend e instale as dependências:

   ```powershell
   npm ci
   ```

4. Gere a configuração local. Se o arquivo `.env` já existir, ele será preservado:

   ```powershell
   npm run setup:env
   ```

5. Inicie o banco e aplique as migrações:

   ```powershell
   npm run db:up
   npm run db:migrate
   ```

6. Se ainda não houver usuário cadastrado, crie o primeiro acesso:

   ```powershell
   npm run usuario:criar
   ```

   Informe nome, e-mail e uma senha com pelo menos 12 caracteres, depois confirme a senha.

7. Inicie o backend e mantenha o terminal aberto:

   ```powershell
   npm run dev
   ```

   A API ficará disponível em `http://127.0.0.1:3000`.

8. Em outro terminal, siga o README do frontend e acesse `http://localhost:5173`.

## Próximas execuções

1. Abra o Docker Desktop.
2. Na pasta do backend, execute:

   ```powershell
   npm run db:up
   npm run db:migrate
   npm run dev
   ```

3. Inicie o frontend em outro terminal.

## Encerrar

1. Pressione `Ctrl+C` no terminal do backend.
2. Para parar o banco mantendo os dados, execute:

   ```powershell
   npm run db:stop
   ```
