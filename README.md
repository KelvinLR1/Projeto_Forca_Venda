# Vértice — Força de Vendas

Primeiro MVP da proposta de força de vendas. A aplicação possui interface web responsiva, pensada para celular e tablet, uma API própria em Node.js e banco SQLite para dados da plataforma. O banco é criado em `forca-vendas.sqlite` na primeira execução e recebe dados de demonstração para facilitar a avaliação.

## Executar

Requer Node.js 24 ou superior. Na pasta do projeto:

```powershell
npm start
```

Abra `http://localhost:3000`. O servidor não exige instalação de dependências externas.

## O que já funciona

- Tela inicial de configuração para criar o primeiro administrador, login e logout.
- Sessões com cookie `HttpOnly`, validade de 12 horas e senhas derivadas com `scrypt`.
- Administração de usuários: criação com perfil, ativação e desativação de contas.
- Dashboard com indicadores da operação e pedidos recentes.
- Relatórios organizados em submenus: visão geral, vendas, pedidos, clientes e produtos.
- Análises por período com evolução de faturamento, comparação com o período anterior, ticket médio, status, clientes e produtos em destaque, além do detalhamento dos pedidos.
- Exportação dos dados do período em CSV para análise complementar.
- Pesquisa e filtros de clientes (segmento e status), produtos (categoria e disponibilidade) e pedidos (status e período); ficha do cliente com análises de compras, pendências, registro e histórico de visitas sem venda, última visita e alerta de retorno conforme prazo configurável por cliente (padrão: 30 dias).
- Cadastro de clientes com notas comerciais adicionais, persistidas no banco próprio.
- Criação de pedidos como rascunho, persistidos no banco próprio.
- Catálogo com consulta por lista de preços e pedidos com uma lista padrão que pode ser substituída por item.
- Preço do pedido: o vendedor escolhe uma lista padrão no início. Cada item herda essa lista e pode usar outra; a prévia ERP mantém um único pedido e informa o preço final e a lista de origem de cada item.
- Atualização dos dados em outras sessões abertas, via eventos em tempo real.
- Chave de idempotência nos pedidos para reduzir duplicidade em reenvios.
- API local em `/api/customers`, `/api/products`, `/api/price-lists`, `/api/orders`, `/api/dashboard` e `/api/reports`.

## Primeiro acesso e permissões

Na primeira execução, abra o endereço local e crie o usuário administrador. Essa configuração só fica disponível enquanto não existir nenhum usuário no banco. Depois, o administrador pode abrir **Acessos** para criar contas de vendedor, gestor ou administrador, além de desativar e reativar contas. Usuários desativados perdem as sessões ativas. Todas as rotas de dados da aplicação exigem uma sessão válida; as rotas de gerenciamento de contas exigem perfil administrador.

As senhas são armazenadas como derivação criptográfica no banco e nunca são devolvidas pela API. Em produção, sirva a aplicação por HTTPS e defina `NODE_ENV=production` para habilitar cookies `Secure`.

## Design system

As referências visuais definem o padrão de cores e superfícies: vermelho em cabeçalhos e ações principais, com áreas de trabalho neutras. A interface oferece temas light e dark pelo botão no cabeçalho e salva a escolha neste dispositivo. Os dois temas mantêm contraste, estados e cores semânticas, além do layout adaptável a telas mobile.

## Acesso mobile e concorrência

A interface adapta navegação, cartões, formulários e tabelas para telas menores. O servidor atende várias conexões HTTP e publica alterações para as sessões abertas; pedidos usam transação e chave de idempotência. O SQLite está configurado para uso local do MVP e não deve ser tratado como banco de produção para múltiplas instâncias ou alto volume de gravações simultâneas. Para operação real com múltiplos vendedores conectados, a próxima etapa técnica inclui autenticação e sessões por usuário, autorização por carteira, migração para PostgreSQL (ou banco servidor equivalente), gestão de conexões e testes de carga com o pico de usuários esperado.

## Integração com ERP

O servidor identifica a configuração por `ERP_API_URL`, mas o adaptador de integração ainda depende do ERP, autenticação e contrato de API do cliente. A conexão real para sincronizar clientes, produtos, preços e estoque, e para enviar pedidos, será implementada quando essas informações forem fornecidas. Não configure tokens no código-fonte. Planeja-se usar variáveis de ambiente/serviço de segredos para as credenciais.

No banco próprio, `price_lists` guarda a lista e seu identificador no ERP; `product_prices` guarda o preço de cada produto nessa lista. O servidor recalcula o preço ao salvar um pedido, sem confiar no valor enviado pelo navegador. Cada item mantém uma cópia do preço e da lista usados no rascunho. O MVP inclui listas **Padrão** e **Atacado** apenas para demonstração. Seus identificadores e valores deverão ser substituídos pelos dados oficiais do ERP.

O vendedor escolhe uma lista de preços padrão ao iniciar cada pedido; cada item pode herdar essa lista ou usar outra. O servidor calcula e salva o preço final de cada item e a respectiva lista de origem. O pedido permanece único no ERP: a futura integração enviará o valor unitário final em cada item, sem dividir o pedido por lista. A tabela `erp_order_dispatches` reserva uma chave estável por pedido para futura idempotência e rastreamento dos identificadores devolvidos pelo ERP. O endpoint `GET /api/orders/:id/erp-preview` mostra esse plano; ele ainda não envia dados externos, pois o contrato do ERP não foi configurado.

O MVP mantém separado o dado adicional da plataforma (por exemplo, notas comerciais) dos dados mestres do ERP. Os registros poderão ser associados por `erp_id` depois de validar as chaves reais disponibilizadas pelo ERP.

## Observação

Esta é uma base inicial para validação funcional, não uma implantação de produção. Antes de uso real, é necessário configurar autenticação, autorização por carteira, banco servidor para concorrência de produção, política de backup, segurança operacional e integração homologada com o ERP.
