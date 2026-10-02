# Proposta de Projeto — Plataforma de Força de Vendas Integrada ao ERP

**Versão:** 1.0  
**Data:** 28/09/2026  
**Status:** Proposta preliminar para alinhamento

## 1. Resumo executivo

Desenvolver uma plataforma de força de vendas para representantes e gestores comerciais, conectada à API do ERP da empresa para leitura e envio de dados. A solução permitirá consultar clientes, produtos, preços e disponibilidade, montar pedidos e acompanhar seu processamento. Também terá um banco de dados próprio para armazenar informações adicionais da operação comercial e utilizá-las nas funcionalidades do sistema quando necessário. O ERP continuará responsável pelos cadastros e regras transacionais oficiais; a plataforma oferecerá uma experiência de venda rápida, com dados sincronizados e rastreabilidade.

O projeto será entregue em etapas, começando por um MVP focado no ciclo de venda: autenticação, carteira de clientes, catálogo, consulta de preço e estoque, criação e envio de pedidos, acompanhamento de status e visão gerencial básica.

## 2. Objetivos e resultados esperados

| Objetivo | Resultado esperado |
| --- | --- |
| Agilizar a operação comercial | Reduzir digitação e consultas manuais ao ERP |
| Melhorar a qualidade dos pedidos | Validar dados, preços e regras antes do envio |
| Dar visibilidade ao vendedor | Mostrar carteira, pedidos e status em uma única interface |
| Dar visibilidade à gestão | Acompanhar atividade e resultados por equipe e período |
| Preservar a consistência dos dados | Definir o ERP como fonte oficial dos dados mestres e do pedido faturável |

As metas numéricas serão definidas na descoberta, usando indicadores atuais como referência.

## 3. Usuários e canais

- **Vendedor/representante:** consulta sua carteira, prepara pedidos e acompanha o andamento.
- **Gestor comercial:** acompanha equipe, pedidos e indicadores consolidados.
- **Administrador:** configura usuários, permissões e parâmetros da integração.

**Canais e concorrência:** aplicação web responsiva, otimizada para uso em celular e adequada também a tablet e computador. A solução deverá suportar vários vendedores e gestores acessando e registrando informações ao mesmo tempo, compartilhando dados atualizados e respeitando as permissões de cada usuário. Um aplicativo nativo e operação totalmente offline poderão ser avaliados após validação do uso em campo.

## 4. Escopo funcional do MVP

1. **Acesso e permissões:** login, recuperação de acesso, perfis e restrição da carteira por vendedor, incluindo sessões independentes para usuários simultâneos.
2. **Clientes:** busca e visualização de dados comerciais, endereços e condições disponibilizadas pelo ERP.
3. **Catálogo:** produtos, descrições, códigos, unidades, imagens quando disponíveis e filtros de pesquisa.
4. **Preço e disponibilidade:** consulta das tabelas, descontos permitidos e estoque conforme regras e dados expostos pela API do ERP.
5. **Pedido:** carrinho, quantidades, condições comerciais, validações, revisão e envio ao ERP.
6. **Acompanhamento:** número do pedido no ERP, situação de integração, status comercial e histórico de alterações relevantes.
7. **Painel gerencial básico:** pedidos por período, vendedor, cliente e status; exportação simples, se necessária.
8. **Administração e operação:** gestão de usuários, parâmetros de sincronização, registros de erro e opção de reprocessamento controlado.
9. **Dados próprios da força de vendas:** cadastro, consulta e uso de informações adicionais não fornecidas pelo ERP, conforme regras definidas na descoberta, como anotações comerciais, preferências de atendimento e campos personalizados.
10. **Relatórios e análises:** faturamento, pedidos, ticket médio, evolução por período, distribuição por status e rankings de clientes e produtos, com exportação CSV.
11. **Listas de preços:** seleção de uma lista padrão no início do pedido; cada produto herda essa lista e pode receber outra individualmente. O preço final e a lista de origem ficam salvos no item, e a integração envia um único pedido com o preço de cada item.

### Fora do escopo inicial

CRM completo, roteirização, cobrança, emissão fiscal, gestão de comissões, assinatura eletrônica, aplicativo nativo e operação offline completa. Esses itens podem compor uma segunda fase após priorização.

## 5. Integração com o ERP

### Fluxos previstos

| Dado/processo | Direção principal | Estratégia inicial |
| --- | --- | --- |
| Clientes e carteira | ERP → plataforma | Sincronização incremental ou consulta, conforme API |
| Produtos e categorias | ERP → plataforma | Sincronização periódica |
| Preços, descontos e estoque | ERP → plataforma | Consulta em tempo próximo ao pedido; cache com validade definida |
| Pedido | Plataforma → ERP | Envio autenticado com identificador único para evitar duplicidade |
| Número e status do pedido | ERP → plataforma | Webhook, se disponível; caso contrário, consulta periódica |

### Regras de integração

- Confirmar com o fornecedor do ERP os endpoints, autenticação, limites de requisição, paginação, filtros, webhooks e ambiente de homologação.
- Mapear campos e regras comerciais antes da implementação; documentar divergências entre os modelos de dados.
- Manter estados separados para **pedido salvo na plataforma**, **enviado**, **aceito pelo ERP** e **rejeitado**, com mensagem legível e possibilidade de correção.
- Usar chaves de idempotência ou referência externa no envio de pedidos; definir política de tentativas e reprocessamento.
- Registrar eventos técnicos com identificadores de correlação, sem expor credenciais ou dados pessoais desnecessários.
- Estabelecer política para indisponibilidade do ERP: consulta a dados recentes quando apropriado, aviso ao usuário e fila de envio sujeita a validação posterior.
- Relacionar os registros do banco próprio aos identificadores do ERP, definindo para cada campo sua origem, responsável pela atualização e regra de sincronização.
- O ERP aceita uma lista de preços por pedido, mas a plataforma permite escolher uma lista padrão e substituí-la em itens específicos. A integração manterá um pedido único e enviará a cada item o preço final calculado da lista selecionada, sem criar pedidos separados por lista.
- Antes do envio real, confirmar o mapeamento das listas e revalidar preço e condições conforme a API do ERP. Se apenas parte dos grupos for aceita, preservar os resultados recebidos e permitir retentativa somente dos grupos pendentes ou rejeitados.

## 6. Arquitetura proposta

```text
Vendedores e gestores
        │
Aplicação web responsiva
        │
API da força de vendas ── Banco de dados da aplicação
        │                         │
Módulo de integração ─────── Fila de processamento
        │
API do ERP
```

A plataforma terá um **banco de dados próprio**, independente do banco do ERP. Nele serão persistidos usuários, permissões, rascunhos, referências e histórico de integração, além de dados adicionais criados pela força de vendas. Essas informações poderão ser consultadas e combinadas com os dados recebidos da API do ERP para atender às telas, fluxos e relatórios do sistema. Quando apropriado, dados do ERP poderão ser armazenados temporariamente para desempenho e continuidade operacional, com regras explícitas de atualização e validade.

Os cadastros e as transações oficiais permanecerão sob governança do ERP. O banco próprio será a fonte oficial apenas dos dados adicionais definidos para a plataforma; não substituirá a validação do ERP para preços, estoque ou aceitação de pedidos. A escolha de linguagem, banco e infraestrutura será feita considerando o ambiente existente da empresa, requisitos não funcionais e competências da equipe.

A experiência será projetada primeiro para celular: navegação simples, alvos de toque confortáveis, formulários curtos, busca rápida e boa leitura em telas estreitas. O backend e o banco deverão atender vários usuários ao mesmo tempo, com isolamento de acesso, tratamento de gravações concorrentes e consistência de pedidos. SQLite pode atender desenvolvimento e demonstração em uma instância; para produção com acessos simultâneos e possibilidade de mais de uma instância da aplicação, recomenda-se um banco servidor, como PostgreSQL, além de sessões e autenticação seguras. A capacidade será dimensionada com a quantidade esperada de usuários e operações.

## 7. Segurança e privacidade

- Comunicação criptografada por HTTPS e credenciais da integração protegidas em serviço de segredos.
- Controle de acesso por perfil e carteira; registro de ações críticas.
- Princípio do menor privilégio para acesso à API do ERP e às informações de clientes.
- Política de retenção, cópias de segurança e recuperação conforme requisitos da empresa.
- Tratamento de dados pessoais alinhado à LGPD, com revisão jurídica e de segurança conforme a operação real.

## 8. Plano de execução e estimativa inicial

| Etapa | Duração indicativa | Entregas |
| --- | --- | --- |
| Descoberta e desenho | 2 semanas | Requisitos priorizados, jornadas, mapeamento da API, protótipo e critérios de aceite |
| Fundação técnica | 2 semanas | Ambientes, autenticação, arquitetura, integração inicial e observabilidade |
| Desenvolvimento do MVP | 6 a 8 semanas | Clientes, catálogo, preços, estoque, pedidos e painel básico |
| Homologação e ajustes | 2 semanas | Testes integrados, correções, treinamento e plano de implantação |
| Implantação assistida | 1 a 2 semanas | Publicação, monitoramento e apoio ao uso inicial |

**Prazo indicativo total:** 13 a 16 semanas, sujeito à qualidade e disponibilidade da API do ERP, às regras comerciais e ao tempo de homologação do cliente. O cronograma definitivo deve ser fechado após a descoberta.

## 9. Entregáveis

- Documento de requisitos, regras de negócio e mapeamento de dados com o ERP.
- Protótipo das principais telas e fluxos aprovado pelos responsáveis.
- Aplicação web, API própria e módulo de integração implantados nos ambientes acordados.
- Documentação técnica, operacional e de uso.
- Roteiros e evidências dos testes de integração e homologação.
- Treinamento dos usuários chave e apoio à implantação.

## 10. Critérios de aceite do MVP

1. O vendedor acessa apenas clientes e pedidos permitidos ao seu perfil.
2. Clientes e produtos exibidos correspondem aos dados homologados no ERP, dentro da frequência de atualização acordada.
3. O sistema mostra preço e disponibilidade conforme as regras aprovadas e informa quando os dados não estiverem atualizados.
4. Um pedido válido é recebido uma única vez pelo ERP e retorna um identificador rastreável.
5. Pedidos rejeitados exibem o motivo e podem ser corrigidos ou reenviados conforme a regra definida.
6. Gestores visualizam pedidos e indicadores do período com filtros acordados.
7. Os fluxos críticos passam nos testes de segurança, integração e uso definidos na descoberta.
8. Os dados adicionais cadastrados na plataforma são salvos no banco próprio, recuperados corretamente e utilizados nos fluxos aprovados, mantendo o vínculo com os respectivos registros do ERP quando aplicável.
9. Os principais fluxos de venda funcionam em celular e tablet, sem perda de conteúdo ou ações inacessíveis em telas estreitas.
10. Usuários simultâneos conseguem consultar e registrar operações sem duplicidade ou perda de dados, e cada perfil acessa apenas a carteira autorizada.
11. Relatórios respeitam o período selecionado e apresentam valores consistentes com os pedidos registrados; a exportação CSV contém os mesmos dados exibidos.

## 11. Dependências e riscos

| Dependência ou risco | Tratamento proposto |
| --- | --- |
| API do ERP incompleta, instável ou sem homologação | Validar endpoints e credenciais na primeira etapa; priorizar prova de integração |
| Regras comerciais não documentadas | Fazer oficinas com comercial e responsável pelo ERP; aprovar exemplos concretos |
| Divergência de preços ou estoque durante o pedido | Revalidar antes do envio e comunicar alterações ao vendedor |
| Pedidos duplicados por falha de comunicação | Usar identificador externo, idempotência e reconciliação |
| Baixa adoção pelos vendedores | Testar protótipo com usuários reais e oferecer treinamento curto |

## 12. Premissas para orçamento e contrato

Esta proposta descreve o escopo técnico e funcional, sem preço fechado. Para compor orçamento, equipe e cronograma contratual, é necessário confirmar:

1. Nome, versão e documentação da API do ERP; ambiente de testes e contato técnico.
2. Quantidade de vendedores, gestores, clientes, produtos e pedidos por dia.
3. Regras de preço, descontos, crédito, impostos, frete, aprovação e carteira.
4. Necessidade de uso offline, aplicativo nativo e dispositivos utilizados em campo.
5. Infraestrutura, autenticação corporativa, requisitos de segurança e suporte esperados.
6. Responsáveis do cliente pela validação e homologação de cada fluxo.
7. Número esperado de usuários simultâneos, horários de pico, volume de pedidos e modelos de dispositivos utilizados em campo.

**Próximo passo recomendado:** realizar uma descoberta técnica e funcional com as áreas comercial, TI e responsável pelo ERP para transformar esta proposta preliminar em escopo, cronograma e orçamento fechados.
